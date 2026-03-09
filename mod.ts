// @deno-types="https://deno.land/x/servest/types/react/index.d.ts"
import {
  type APIInteraction,
  type APIInteractionResponse,
  ApplicationCommandType,
  crypto,
  InteractionResponseType,
  InteractionType,
  serve,
} from "./deps.ts";

// ===== CACHING CONFIGURATION =====
const CACHE_DURATION_MS = 3 * 24 * 60 * 60 * 1000; // 3 days in milliseconds
const CACHE_KEY_PREFIX = "ethos_user_sync:";

// Initialize Deno KV
let kv: Deno.Kv | null = null;
try {
  kv = await Deno.openKv();
  console.log("✅ Deno KV initialized successfully");
} catch (error) {
  console.warn("⚠️ Deno KV failed to initialize:", error.message);
  console.warn("⚠️ Caching features will be disabled");
}

// Helper function to get cache key for a user
function getCacheKey(userId: string): string {
  return `${CACHE_KEY_PREFIX}${userId}`;
}

// Helper function to check if user was recently synced successfully
async function wasRecentlySynced(userId: string): Promise<boolean> {
  if (!kv) return false; // No cache available
  
  try {
    const result = await kv.get([getCacheKey(userId)]);
    if (!result.value) {
      return false;
    }

    const lastSyncTime = result.value as number;
    const now = Date.now();
    const timeSinceSync = now - lastSyncTime;

    return timeSinceSync < CACHE_DURATION_MS;
  } catch (error) {
    console.error(`Error checking cache for user ${userId}:`, error);
    return false; // If cache check fails, don't skip the user
  }
}

// Helper function to mark user as successfully synced
async function markUserSynced(userId: string): Promise<void> {
  if (!kv) return; // No cache available
  
  try {
    await kv.set([getCacheKey(userId)], Date.now());
  } catch (error) {
    console.error(`Error updating cache for user ${userId}:`, error);
    // Don't throw - cache failures shouldn't break the sync
  }
}

// Helper function to clear cache for a user (useful for forced updates)
async function clearUserCache(userId: string): Promise<void> {
  if (!kv) return; // No cache available
  
  try {
    await kv.delete([getCacheKey(userId)]);
  } catch (error) {
    console.error(`Error clearing cache for user ${userId}:`, error);
  }
}

// Helper function to get cache stats
async function getCacheStats(): Promise<
  {
    totalCached: number;
    oldestEntry: number | null;
    newestEntry: number | null;
  }
> {
  if (!kv) return { totalCached: 0, oldestEntry: null, newestEntry: null };
  
  try {
    let totalCached = 0;
    let oldestEntry: number | null = null;
    let newestEntry: number | null = null;

    for await (const entry of kv.list({ prefix: [CACHE_KEY_PREFIX] })) {
      totalCached++;
      const timestamp = entry.value as number;

      if (oldestEntry === null || timestamp < oldestEntry) {
        oldestEntry = timestamp;
      }
      if (newestEntry === null || timestamp > newestEntry) {
        newestEntry = timestamp;
      }
    }

    return { totalCached, oldestEntry, newestEntry };
  } catch (error) {
    console.error("Error getting cache stats:", error);
    return { totalCached: 0, oldestEntry: null, newestEntry: null };
  }
}

// Load environment variables
const PUBLIC_KEY = Deno.env.get("DISCORD_PUBLIC_KEY");
const APPLICATION_ID = Deno.env.get("DISCORD_APPLICATION_ID");

// Discord bot token (used by discordApiCall and Gateway WebSocket)
const DISCORD_TOKEN = Deno.env.get("DISCORD_TOKEN");

// Discord webhook URL for role change notifications
const WEBHOOK_URL = Deno.env.get("DISCORD_WEBHOOK_URL");
// Meta role IDs (not score-based)
const ETHOS_VERIFIED_ROLE_ID = "1330927513056186501"; // "verified" role (Discord connected)
const ETHOS_VERIFIED_PROFILE_ROLE_ID = "1367923031040721046"; // "Verified ethos profile" role (active profile)
const ROLE_TO_REMOVE_ON_VERIFY = "1410662938376802415"; // Legacy/temporary role removed on verify
// Standalone meta roles — assigned based on status for easy @mention
let ETHOS_VALIDATOR_META_ROLE_ID: string | null = null;
let ETHOS_HUMAN_VERIFIED_META_ROLE_ID: string | null = null;
let ETHOS_HUMAN_VALIDATOR_META_ROLE_ID: string | null = null;

// ===== DATA-DRIVEN ROLE CONFIGURATION =====

// Score tiers ordered highest-first for matching
const SCORE_TIERS: { name: string; minScore: number; color: number }[] = [
  { name: "Renowned",      minScore: 2600, color: 0x7A5EA0 }, // Purple
  { name: "Revered",       minScore: 2400, color: 0x836DA6 }, // Light Purple
  { name: "Distinguished", minScore: 2200, color: 0x127F31 }, // Green
  { name: "Exemplary",     minScore: 2000, color: 0x427B56 }, // Dark Green
  { name: "Reputable",     minScore: 1800, color: 0x2E7BC3 }, // Blue
  { name: "Established",   minScore: 1600, color: 0x4E86B9 }, // Light Blue
  { name: "Known",         minScore: 1400, color: 0x7C8DA8 }, // Steel
  { name: "Neutral",       minScore: 1200, color: 0xC1C0B6 }, // Gray
  { name: "Questionable",  minScore: 800,  color: 0xC29010 }, // Yellow
  { name: "Untrusted",     minScore: 0,    color: 0xB72B38 }, // Red
];

// Badge variants: key is stored in registry, suffix is appended to tier name for Discord role name
const BADGE_VARIANTS: { key: string; suffix: string }[] = [
  { key: "base",            suffix: "" },
  { key: "validator",       suffix: " Validator" },
  { key: "human",           suffix: " Human" },
  { key: "human_validator", suffix: " Human Validator" },
];

// Untrusted only gets the base variant
function getVariantsForTier(tierName: string): string[] {
  if (tierName === "Untrusted") return ["base"];
  return BADGE_VARIANTS.map((v) => v.key);
}

// In-memory map: "TierName:variant" → Discord role ID
const roleRegistry = new Map<string, string>();

// Legacy hardcoded role IDs for migration/cleanup
const LEGACY_ROLE_IDS: Record<string, string> = {
  // Regular roles
  "Distinguished:base": "1403227201809285214",
  "Exemplary:base": "1253205892917231677",
  "Reputable:base": "1253206005169258537",
  "Established:base": "1403226783540842546",
  "Known:base": "1403227015959548005",
  "Neutral:base": "1253206143182831637",
  "Questionable:base": "1253206252306305024",
  "Untrusted:base": "1253206385877975043",
  // Validator roles
  "Distinguished:validator": "1403227263318757470",
  "Exemplary:validator": "1377685521723293706",
  "Reputable:validator": "1377477396759842936",
  "Established:validator": "1403226922443345981",
  "Known:validator": "1403227117415825458",
  "Neutral:validator": "1377685710026571876",
  "Questionable:validator": "1377688531522158632",
};

// Global initialization state
let roleInitPromise: Promise<void> | null = null;

// Emoji registry: name → "<:name:id>" format string (populated during initializeRoles)
const emojiRegistry = new Map<string, string>();

// Initialize all score roles in the Discord guild (create if missing, store in KV)
async function initializeRoles(guildId: string): Promise<void> {
  console.log("[ROLE-INIT] === Starting role initialization ===");
  const startTime = Date.now();

  // 1. Load any previously stored role IDs from Deno KV
  const kvRoleIds = new Map<string, string>();
  if (kv) {
    for await (const entry of kv.list({ prefix: ["ethos_role_id"] })) {
      const [, tierName, variant] = entry.key as [string, string, string];
      kvRoleIds.set(`${tierName}:${variant}`, entry.value as string);
    }
    console.log(`[ROLE-INIT] Loaded ${kvRoleIds.size} role IDs from KV`);
  }

  // 2. Fetch all existing guild roles
  const guildRolesUrl = `https://discord.com/api/v10/guilds/${guildId}/roles`;
  const guildRolesResponse = await discordApiCall(guildRolesUrl, { method: "GET" });
  if (!guildRolesResponse.ok) {
    console.error(`[ROLE-INIT] Failed to fetch guild roles: ${guildRolesResponse.status}`);
    // Fall back to KV + legacy IDs
    for (const [key, id] of kvRoleIds) roleRegistry.set(key, id);
    for (const [key, id] of Object.entries(LEGACY_ROLE_IDS)) {
      if (!roleRegistry.has(key)) roleRegistry.set(key, id);
    }
    // roles initialized
    console.log(`[ROLE-INIT] Fell back to ${roleRegistry.size} cached/legacy roles`);
    return;
  }

  const guildRoles: { id: string; name: string }[] = await guildRolesResponse.json();
  const guildRolesByName = new Map<string, string>();
  const guildRoleIdsSet = new Set<string>();
  for (const role of guildRoles) {
    guildRolesByName.set(role.name, role.id);
    guildRoleIdsSet.add(role.id);
  }
  console.log(`[ROLE-INIT] Guild has ${guildRoles.length} roles`);

  let createdCount = 0;

  // 3. For each tier+variant, find or create the role
  for (const tier of SCORE_TIERS) {
    const variants = getVariantsForTier(tier.name);
    for (const variantKey of variants) {
      const registryKey = `${tier.name}:${variantKey}`;
      const variant = BADGE_VARIANTS.find((v) => v.key === variantKey)!;
      const roleName = `${tier.name}${variant.suffix}`;

      // Check KV first — if the stored ID still exists in the guild, use it
      const kvId = kvRoleIds.get(registryKey);
      if (kvId && guildRoleIdsSet.has(kvId)) {
        roleRegistry.set(registryKey, kvId);
        continue;
      }

      // Check legacy IDs
      const legacyId = LEGACY_ROLE_IDS[registryKey];
      if (legacyId && guildRoleIdsSet.has(legacyId)) {
        roleRegistry.set(registryKey, legacyId);
        // Persist to KV
        if (kv) await kv.set(["ethos_role_id", tier.name, variantKey], legacyId);
        continue;
      }

      // Search guild roles by exact name match
      const existingId = guildRolesByName.get(roleName);
      if (existingId) {
        roleRegistry.set(registryKey, existingId);
        if (kv) await kv.set(["ethos_role_id", tier.name, variantKey], existingId);
        console.log(`[ROLE-INIT] Found existing role "${roleName}" (${existingId})`);
        continue;
      }

      // Create the role
      console.log(`[ROLE-INIT] Creating role "${roleName}" with color 0x${tier.color.toString(16)}`);
      const createUrl = `https://discord.com/api/v10/guilds/${guildId}/roles`;
      const createResponse = await discordApiCall(createUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: roleName,
          color: tier.color,
          hoist: false,
          mentionable: false,
        }),
      });

      if (createResponse.ok) {
        const newRole = await createResponse.json();
        roleRegistry.set(registryKey, newRole.id);
        if (kv) await kv.set(["ethos_role_id", tier.name, variantKey], newRole.id);
        guildRoleIdsSet.add(newRole.id);
        createdCount++;
        console.log(`[ROLE-INIT] Created role "${roleName}" (${newRole.id})`);
      } else {
        console.error(`[ROLE-INIT] Failed to create role "${roleName}": ${createResponse.status}`);
        // Use legacy ID as last resort
        if (legacyId) {
          roleRegistry.set(registryKey, legacyId);
        }
      }

      // Rate-limit delay between role creations
      if (createdCount > 0) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  // Initialize the standalone "Validator" meta role
  const validatorMetaName = "Validator";
  const kvValidatorMeta = kv ? (await kv.get(["ethos_role_id", "_meta", "validator"])).value as string | null : null;
  if (kvValidatorMeta && guildRoleIdsSet.has(kvValidatorMeta)) {
    ETHOS_VALIDATOR_META_ROLE_ID = kvValidatorMeta;
  } else if (guildRolesByName.has(validatorMetaName)) {
    ETHOS_VALIDATOR_META_ROLE_ID = guildRolesByName.get(validatorMetaName)!;
    if (kv) await kv.set(["ethos_role_id", "_meta", "validator"], ETHOS_VALIDATOR_META_ROLE_ID);
  } else {
    const createUrl = `https://discord.com/api/v10/guilds/${guildId}/roles`;
    const createResponse = await discordApiCall(createUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: validatorMetaName, color: 0x000000, hoist: false, mentionable: true }),
    });
    if (createResponse.ok) {
      const newRole = await createResponse.json();
      ETHOS_VALIDATOR_META_ROLE_ID = newRole.id;
      if (kv) await kv.set(["ethos_role_id", "_meta", "validator"], newRole.id);
      console.log(`[ROLE-INIT] Created "${validatorMetaName}" meta role (${newRole.id})`);
    } else {
      console.error(`[ROLE-INIT] Failed to create "${validatorMetaName}" meta role: ${createResponse.status}`);
    }
  }
  if (ETHOS_VALIDATOR_META_ROLE_ID) {
    console.log(`[ROLE-INIT] Validator meta role: ${ETHOS_VALIDATOR_META_ROLE_ID}`);
  }

  // Initialize the standalone "Human Verified" meta role
  const hvMetaName = "Human Verified";
  const kvHvMeta = kv ? (await kv.get(["ethos_role_id", "_meta", "human_verified"])).value as string | null : null;
  if (kvHvMeta && guildRoleIdsSet.has(kvHvMeta)) {
    ETHOS_HUMAN_VERIFIED_META_ROLE_ID = kvHvMeta;
  } else if (guildRolesByName.has(hvMetaName)) {
    ETHOS_HUMAN_VERIFIED_META_ROLE_ID = guildRolesByName.get(hvMetaName)!;
    if (kv) await kv.set(["ethos_role_id", "_meta", "human_verified"], ETHOS_HUMAN_VERIFIED_META_ROLE_ID);
  } else {
    const createUrl = `https://discord.com/api/v10/guilds/${guildId}/roles`;
    const createResponse = await discordApiCall(createUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: hvMetaName, color: 0x000000, hoist: false, mentionable: true }),
    });
    if (createResponse.ok) {
      const newRole = await createResponse.json();
      ETHOS_HUMAN_VERIFIED_META_ROLE_ID = newRole.id;
      if (kv) await kv.set(["ethos_role_id", "_meta", "human_verified"], newRole.id);
      console.log(`[ROLE-INIT] Created "${hvMetaName}" meta role (${newRole.id})`);
    } else {
      console.error(`[ROLE-INIT] Failed to create "${hvMetaName}" meta role: ${createResponse.status}`);
    }
  }
  if (ETHOS_HUMAN_VERIFIED_META_ROLE_ID) {
    console.log(`[ROLE-INIT] Human Verified meta role: ${ETHOS_HUMAN_VERIFIED_META_ROLE_ID}`);
  }

  // Initialize the standalone "Human Validator" meta role
  const hvValidatorMetaName = "Human Validator";
  const kvHvValidator = kv ? (await kv.get(["ethos_role_id", "_meta", "human_validator"])).value as string | null : null;
  if (kvHvValidator && guildRoleIdsSet.has(kvHvValidator)) {
    ETHOS_HUMAN_VALIDATOR_META_ROLE_ID = kvHvValidator;
  } else if (guildRolesByName.has(hvValidatorMetaName)) {
    ETHOS_HUMAN_VALIDATOR_META_ROLE_ID = guildRolesByName.get(hvValidatorMetaName)!;
    if (kv) await kv.set(["ethos_role_id", "_meta", "human_validator"], ETHOS_HUMAN_VALIDATOR_META_ROLE_ID);
  } else {
    const createUrl = `https://discord.com/api/v10/guilds/${guildId}/roles`;
    const createResponse = await discordApiCall(createUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: hvValidatorMetaName, color: 0x000000, hoist: false, mentionable: true }),
    });
    if (createResponse.ok) {
      const newRole = await createResponse.json();
      ETHOS_HUMAN_VALIDATOR_META_ROLE_ID = newRole.id;
      if (kv) await kv.set(["ethos_role_id", "_meta", "human_validator"], newRole.id);
      console.log(`[ROLE-INIT] Created "${hvValidatorMetaName}" meta role (${newRole.id})`);
    } else {
      console.error(`[ROLE-INIT] Failed to create "${hvValidatorMetaName}" meta role: ${createResponse.status}`);
    }
  }
  if (ETHOS_HUMAN_VALIDATOR_META_ROLE_ID) {
    console.log(`[ROLE-INIT] Human Validator meta role: ${ETHOS_HUMAN_VALIDATOR_META_ROLE_ID}`);
  }

  // Fetch guild emojis for status badges
  try {
    const emojisUrl = `https://discord.com/api/v10/guilds/${guildId}/emojis`;
    const emojisResponse = await discordApiCall(emojisUrl, { method: "GET" });
    if (emojisResponse.ok) {
      const emojis: { id: string; name: string }[] = await emojisResponse.json();
      const badgeNames = ["human_verified_badge", "human_verified_silver", "validator", "verified_validator"];
      for (const emoji of emojis) {
        if (badgeNames.includes(emoji.name)) {
          emojiRegistry.set(emoji.name, `<:${emoji.name}:${emoji.id}>`);
        }
      }
      console.log(`[ROLE-INIT] Found ${emojiRegistry.size} badge emojis: ${[...emojiRegistry.keys()].join(", ")}`);
    }
  } catch (e) {
    console.warn(`[ROLE-INIT] Failed to fetch guild emojis:`, e);
  }

  const elapsed = Date.now() - startTime;
  console.log(`[ROLE-INIT] === Initialization complete: ${roleRegistry.size} roles registered, ${createdCount} created (${elapsed}ms) ===`);
}

// Get all role IDs that the bot manages (for diffing/cleanup)
function getAllManagedRoleIds(): string[] {
  const ids = new Set<string>();
  // Meta roles
  ids.add(ETHOS_VERIFIED_ROLE_ID);
  ids.add(ETHOS_VERIFIED_PROFILE_ROLE_ID);
  if (ETHOS_VALIDATOR_META_ROLE_ID) ids.add(ETHOS_VALIDATOR_META_ROLE_ID);
  if (ETHOS_HUMAN_VERIFIED_META_ROLE_ID) ids.add(ETHOS_HUMAN_VERIFIED_META_ROLE_ID);
  if (ETHOS_HUMAN_VALIDATOR_META_ROLE_ID) ids.add(ETHOS_HUMAN_VALIDATOR_META_ROLE_ID);
  // All registry roles
  for (const id of roleRegistry.values()) ids.add(id);
  // All legacy role IDs (for migration cleanup)
  for (const id of Object.values(LEGACY_ROLE_IDS)) ids.add(id);
  return [...ids];
}

// AI Help Center env vars
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const INTERCOM_ACCESS_TOKEN = Deno.env.get("INTERCOM_ACCESS_TOKEN");

if (!ANTHROPIC_API_KEY) {
  console.warn("⚠️ ANTHROPIC_API_KEY not set — @mention AI help will be unavailable");
}
if (!INTERCOM_ACCESS_TOKEN) {
  console.warn("⚠️ INTERCOM_ACCESS_TOKEN not set — @mention AI help will be unavailable");
}

if (!PUBLIC_KEY || !APPLICATION_ID) {
  console.error("Environment variables check failed:");
  console.error("DISCORD_PUBLIC_KEY:", PUBLIC_KEY ? "set" : "missing");
  console.error("DISCORD_APPLICATION_ID:", APPLICATION_ID ? "set" : "missing");
  // Don't throw, just log the error
}

// ===== HELP CENTER ARTICLE CACHING =====
interface CachedArticle {
  id: string;
  title: string;
  description: string;
  body: string; // HTML-stripped plain text
  url: string;
  updatedAt: number;
}

const ARTICLES_CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const ARTICLES_KV_KEY = ["help_center_articles"];
const ARTICLES_KV_CHUNK_PREFIX = ["help_center_articles_chunk"];
let articlesCache: CachedArticle[] | null = null;
let articlesCacheTimestamp = 0;

// Strip HTML tags and decode entities to plain text
function stripHtml(html: string): string {
  if (!html) return "";
  let text = html;
  // Replace <br>, <br/>, <br /> with newlines
  text = text.replace(/<br\s*\/?>/gi, "\n");
  // Replace </p>, </div>, </li>, </h1-6> with newlines
  text = text.replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, "\n");
  // Replace <li> with "- "
  text = text.replace(/<li[^>]*>/gi, "- ");
  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");
  // Decode common HTML entities
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");
  // Collapse multiple newlines into at most two
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

// Fetch all published articles from Intercom with pagination
async function fetchIntercomArticles(): Promise<CachedArticle[]> {
  if (!INTERCOM_ACCESS_TOKEN) {
    throw new Error("INTERCOM_ACCESS_TOKEN not configured");
  }

  const articles: CachedArticle[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await fetch(
      `https://api.intercom.io/articles?page=${page}&per_page=50`,
      {
        headers: {
          "Authorization": `Bearer ${INTERCOM_ACCESS_TOKEN}`,
          "Accept": "application/json",
        },
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Intercom API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const pageArticles = data.data || [];

    for (const article of pageArticles) {
      if (article.state !== "published") continue;

      articles.push({
        id: String(article.id),
        title: article.title || "",
        description: article.description || "",
        body: stripHtml(article.body || ""),
        url: article.url || "",
        updatedAt: article.updated_at || 0,
      });
    }

    // Check for more pages
    const totalPages = data.pages?.total_pages || 1;
    if (page >= totalPages) {
      hasMore = false;
    } else {
      page++;
    }
  }

  console.log(`📚 Fetched ${articles.length} published articles from Intercom`);
  return articles;
}

// Load articles from in-memory cache, KV, or Intercom (in that order)
async function loadArticlesCache(): Promise<CachedArticle[]> {
  const now = Date.now();

  // Check in-memory cache first
  if (articlesCache && (now - articlesCacheTimestamp) < ARTICLES_CACHE_DURATION_MS) {
    return articlesCache;
  }

  // Check KV cache
  if (kv) {
    try {
      const kvMeta = await kv.get(ARTICLES_KV_KEY);
      if (kvMeta.value) {
        const meta = kvMeta.value as { count: number; timestamp: number };
        if ((now - meta.timestamp) < ARTICLES_CACHE_DURATION_MS) {
          const articles: CachedArticle[] = [];
          for (let i = 0; i < meta.count; i++) {
            const chunk = await kv.get([...ARTICLES_KV_CHUNK_PREFIX, i]);
            if (chunk.value) {
              articles.push(...(chunk.value as CachedArticle[]));
            }
          }
          if (articles.length > 0) {
            articlesCache = articles;
            articlesCacheTimestamp = meta.timestamp;
            console.log(`📚 Loaded ${articles.length} articles from KV cache (${meta.count} chunks)`);
            return articlesCache;
          }
        }
      }
    } catch (error) {
      console.warn("⚠️ Error reading articles from KV:", error);
    }
  }

  // Fetch fresh from Intercom
  const articles = await fetchIntercomArticles();
  articlesCache = articles;
  articlesCacheTimestamp = now;

  // Persist to KV in chunks (max ~60KB per KV value)
  if (kv) {
    try {
      const CHUNK_SIZE = 5; // 5 articles per chunk to stay well under 64KB
      const chunks: CachedArticle[][] = [];
      for (let i = 0; i < articles.length; i += CHUNK_SIZE) {
        chunks.push(articles.slice(i, i + CHUNK_SIZE));
      }
      for (let i = 0; i < chunks.length; i++) {
        await kv.set([...ARTICLES_KV_CHUNK_PREFIX, i], chunks[i]);
      }
      await kv.set(ARTICLES_KV_KEY, { count: chunks.length, timestamp: now });
      console.log(`💾 Saved ${articles.length} articles to KV in ${chunks.length} chunks`);
    } catch (error) {
      console.warn("⚠️ Error saving articles to KV:", error);
    }
  }

  return articles;
}

// Force-refresh articles from Intercom, updating both KV and in-memory cache
async function refreshArticlesCache(): Promise<CachedArticle[]> {
  const articles = await fetchIntercomArticles();
  const now = Date.now();
  articlesCache = articles;
  articlesCacheTimestamp = now;

  if (kv) {
    try {
      const CHUNK_SIZE = 5;
      const chunks: CachedArticle[][] = [];
      for (let i = 0; i < articles.length; i += CHUNK_SIZE) {
        chunks.push(articles.slice(i, i + CHUNK_SIZE));
      }
      for (let i = 0; i < chunks.length; i++) {
        await kv.set([...ARTICLES_KV_CHUNK_PREFIX, i], chunks[i]);
      }
      await kv.set(ARTICLES_KV_KEY, { count: chunks.length, timestamp: now });
      console.log(`💾 Saved ${articles.length} articles to KV in ${chunks.length} chunks`);
    } catch (error) {
      console.warn("⚠️ Error saving articles to KV:", error);
    }
  }

  return articles;
}

// ===== ETHOS CLI TOOL DEFINITIONS =====
const ETHOS_CLI_TOOLS = [
  {
    name: "ethos_user_info",
    description: "Get a user's Ethos profile including credibility score, XP, review/vouch counts, and connected addresses. Use for questions about someone's score, reputation, or profile.",
    input_schema: {
      type: "object" as const,
      properties: {
        identifier: {
          type: "string",
          description: "Username, ENS name, Ethereum address, or Ethos profile ID",
        },
      },
      required: ["identifier"],
    },
  },
  {
    name: "ethos_user_search",
    description: "Search for Ethos users by name or handle. Use when the user asks to find someone or you need to look up a username.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (name, handle, or partial match)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "ethos_review_list",
    description: "List reviews written about a user. Use for questions about someone's reviews, positive/negative feedback, or what others think of them.",
    input_schema: {
      type: "object" as const,
      properties: {
        identifier: {
          type: "string",
          description: "Username, ENS name, Ethereum address, or Ethos profile ID",
        },
      },
      required: ["identifier"],
    },
  },
  {
    name: "ethos_vouch_list",
    description: "List vouches for a user. Use for questions about who vouched for someone or their vouch history.",
    input_schema: {
      type: "object" as const,
      properties: {
        identifier: {
          type: "string",
          description: "Username, ENS name, Ethereum address, or Ethos profile ID",
        },
      },
      required: ["identifier"],
    },
  },
  {
    name: "ethos_xp_rank",
    description: "Get a user's XP leaderboard ranking. Use for questions about someone's rank or standing on the leaderboard.",
    input_schema: {
      type: "object" as const,
      properties: {
        identifier: {
          type: "string",
          description: "Username, ENS name, Ethereum address, or Ethos profile ID",
        },
      },
      required: ["identifier"],
    },
  },
];

// Find the ethos CLI — returns [command, prefixArgs]
// Uses node + absolute path to bypass PATH resolution issues in containers
function findEthosCliCommand(): [string, string[]] {
  // In Docker: run the CLI entry point directly via node
  const globalRoot = "/usr/lib/node_modules";
  const cliEntry = `${globalRoot}/@trust-ethos/cli/bin/run.js`;
  try {
    Deno.statSync(cliEntry);
    console.log(`🔧 Ethos CLI: using node ${cliEntry}`);
    return ["node", [cliEntry]];
  } catch {
    // Not in Docker — use bare 'ethos' from PATH (local dev)
  }

  console.log("🔧 Ethos CLI: using 'ethos' from PATH");
  return ["ethos", []];
}

const [ETHOS_CMD, ETHOS_CMD_PREFIX] = findEthosCliCommand();

// Run an ethos CLI command with timeout and JSON parsing
async function runEthosCli(args: string[]): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const command = new Deno.Command(ETHOS_CMD, {
      args: [...ETHOS_CMD_PREFIX, ...args, "--json"],
      stdout: "piped",
      stderr: "piped",
    });

    const process = command.spawn();

    // 15-second timeout
    const timeout = setTimeout(() => {
      try {
        process.kill("SIGTERM");
      } catch {
        // Process may have already exited
      }
    }, 15_000);

    const output = await process.output();
    clearTimeout(timeout);

    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);

    if (!output.success) {
      return { success: false, error: stderr || `CLI exited with code ${output.code}` };
    }

    try {
      const data = JSON.parse(stdout);
      return { success: true, data };
    } catch {
      // If JSON parse fails, return raw output
      return { success: true, data: stdout.trim() };
    }
  } catch (error) {
    return { success: false, error: `CLI execution failed: ${error.message}` };
  }
}

// Validate CLI input to prevent abuse
function validateCliInput(input: string): boolean {
  return /^[a-zA-Z0-9._\-:@]+$/.test(input) && input.length <= 100;
}

// Execute an Ethos tool call and return the result
async function executeEthosTool(toolName: string, toolInput: Record<string, string>): Promise<string> {
  const MAX_OUTPUT_CHARS = 8000;

  const id = toolInput.identifier || toolInput.query || "";
  if (!validateCliInput(id)) {
    return JSON.stringify({ error: "Invalid input: only alphanumeric characters, dots, hyphens, underscores, colons, and @ are allowed (max 100 chars)" });
  }

  let args: string[];
  switch (toolName) {
    case "ethos_user_info":
      args = ["user", "info", id];
      break;
    case "ethos_user_search":
      args = ["user", "search", id];
      break;
    case "ethos_review_list":
      args = ["review", "list", id];
      break;
    case "ethos_vouch_list":
      args = ["vouch", "list", id];
      break;
    case "ethos_xp_rank":
      args = ["xp", "rank", id];
      break;
    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }

  const result = await runEthosCli(args);

  if (!result.success) {
    console.error(`❌ CLI tool ${toolName} failed:`, result.error);
  } else {
    console.log(`✅ CLI tool ${toolName} succeeded`);
  }

  let output = JSON.stringify(result);

  if (output.length > MAX_OUTPUT_CHARS) {
    output = output.substring(0, MAX_OUTPUT_CHARS) + "...(truncated)";
  }

  return output;
}

// Call Claude API with help center articles as context and Ethos CLI tools
async function askClaude(question: string, articles: CachedArticle[]): Promise<string> {
  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }

  // Build article context
  const articleContext = articles.map((a) =>
    `## ${a.title}\n${a.description ? a.description + "\n" : ""}${a.body}\n${a.url ? `URL: ${a.url}` : ""}`
  ).join("\n\n---\n\n");

  const systemPrompt = `You are the Ethos Network assistant. You have two sources of information:

1. **Help center articles** (below) — use these for how-to questions, explanations of features, and general guidance.
2. **Live data tools** — use these to look up specific user data like credibility scores, reviews, vouches, and rankings.

For how-to questions (e.g. "how do I verify?"), answer from the articles. For questions about specific users or live data (e.g. "what's vitalik's score?"), use the tools. You can combine both sources when helpful.

When relevant, include links to specific articles using their URLs.

Keep your response under 1800 characters so it fits in a Discord message.

---
HELP CENTER ARTICLES:
${articleContext}`;

  const messages: Array<{ role: string; content: any }> = [
    { role: "user", content: question },
  ];

  const MAX_TOOL_ROUNDS = 3;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 2048,
        system: systemPrompt,
        messages,
        tools: ETHOS_CLI_TOOLS,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Claude API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();

    // If stop reason is not tool_use, extract final text and return
    if (data.stop_reason !== "tool_use") {
      const textBlock = data.content?.find((b: any) => b.type === "text");
      return textBlock?.text || "I wasn't able to generate an answer. Please try again.";
    }

    // Process tool calls
    messages.push({ role: "assistant", content: data.content });

    const toolResults: Array<{ type: string; tool_use_id: string; content: string }> = [];
    for (const block of data.content) {
      if (block.type === "tool_use") {
        console.log(`🔧 Executing tool: ${block.name}`, block.input);
        const result = await executeEthosTool(block.name, block.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
  }

  // If we exhausted all rounds, make one final call without tools to get a text answer
  const finalResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 2048,
      system: systemPrompt,
      messages,
    }),
  });

  if (!finalResponse.ok) {
    const errorText = await finalResponse.text();
    throw new Error(`Claude API error ${finalResponse.status}: ${errorText}`);
  }

  const finalData = await finalResponse.json();
  const textBlock = finalData.content?.find((b: any) => b.type === "text");
  return textBlock?.text || "I wasn't able to generate an answer. Please try again.";
}

// Helper function to check if a handle is likely a Discord handle
function isDiscordHandle(handle: string): boolean {
  // Discord handles typically don't start with @ and may contain a #
  return !handle.startsWith("@") || handle.includes("#");
}



// Function to check if a user owns a validator NFT
async function checkUserOwnsValidator(userId: string): Promise<boolean> {
  try {
    console.log("Checking if Discord user owns validator NFT:", userId);

    // Make sure we're just using the raw ID without any @ symbol
    const cleanUserId = userId.replace("@", "").replace("<", "").replace(
      ">",
      "",
    );
    const userkey = `service:discord:${cleanUserId}`;

    // Check if user owns a validator using the v2 API endpoint
    const validatorResponse = await fetch(
      `https://api.ethos.network/api/v2/nfts/user/${userkey}/owns-validator`,
      {
        headers: {
          "X-Ethos-Client": "ethos-discord",
        },
      },
    );

    if (!validatorResponse.ok) {
      console.log(
        `Validator check failed with status: ${validatorResponse.status}`,
      );
      return false;
    }

    const validatorData = await validatorResponse.json();
    console.log(
      "Validator API Response:",
      JSON.stringify(validatorData, null, 2),
    );

    // The API returns an array of validator NFTs. If the array has any items, the user owns a validator
    return Array.isArray(validatorData) && validatorData.length > 0;
  } catch (error) {
    console.error("Error checking if user owns validator:", error);
    return false;
  }
}

// Get human verification, validator status, XP, and influence from a single API call
async function getUserVerificationStatus(userId: string): Promise<{ isHumanVerified: boolean; hasValidator: boolean; xpTotal: number | null; influenceFactor: number | null }> {
  try {
    const cleanUserId = userId.replace("@", "").replace("<", "").replace(">", "");
    const response = await fetch(`https://api.ethos.network/api/v2/users/by/discord`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ethos-Client": "ethos-discord",
      },
      body: JSON.stringify({ discordIds: [cleanUserId] }),
    });

    if (!response.ok) {
      console.log(`getUserVerificationStatus failed for ${userId}: ${response.status}`);
      // Fall back to legacy validator check
      const hasValidator = await checkUserOwnsValidator(userId);
      return { isHumanVerified: false, hasValidator, xpTotal: null, influenceFactor: null };
    }

    const data = await response.json();
    const entries = data.data || data;
    const userDataArray = Array.isArray(entries) ? entries : [entries];

    for (const userData of userDataArray) {
      if (!userData) continue;
      const discordUserkey = userData.userkeys?.find((uk: string) => uk.startsWith("service:discord:"));
      if (discordUserkey) {
        const uid = discordUserkey.replace("service:discord:", "");
        if (uid === cleanUserId) {
          const isHumanVerified = userData.humanVerificationStatus === "VERIFIED";
          const hasValidator = (userData.validatorNftCount || 0) > 0;
          const xpTotal = userData.xpTotal ?? null;
          const influenceFactor = userData.influenceFactor ?? null;
          console.log(`getUserVerificationStatus(${userId}): humanVerified=${isHumanVerified}, validator=${hasValidator}, xp=${xpTotal}, influence=${influenceFactor}`);
          return { isHumanVerified, hasValidator, xpTotal, influenceFactor };
        }
      }
    }

    // User not found in response — fall back to legacy validator check
    const hasValidator = await checkUserOwnsValidator(userId);
    return { isHumanVerified: false, hasValidator, xpTotal: null, influenceFactor: null };
  } catch (error) {
    console.error(`Error in getUserVerificationStatus(${userId}):`, error);
    const hasValidator = await checkUserOwnsValidator(userId);
    return { isHumanVerified: false, hasValidator, xpTotal: null, influenceFactor: null };
  }
}

// Enhanced rate limiting state
let rateLimitState = {
  isGloballyRateLimited: false,
  globalRateLimitUntil: 0,
  routeRateLimits: new Map<string, { remaining: number; resetAt: number }>(),
  adaptiveDelayMultiplier: 1,
  lastRateLimitTime: 0,
};

// Function to get route key for rate limiting
function getRouteKey(url: string, method: string): string {
  const urlObj = new URL(url);
  // Create a simplified route key for similar endpoints
  const path = urlObj.pathname
    .replace(/\/\d+/g, '/:id') // Replace numeric IDs
    .replace(/\/guilds\/\d+\/members\/\d+/, '/guilds/:guild_id/members/:user_id');
  return `${method}:${path}`;
}

// Function to get rate limit status for monitoring
export function getRateLimitStatus() {
  const now = Date.now();
  return {
    isGloballyRateLimited: rateLimitState.isGloballyRateLimited,
    globalRateLimitUntil: rateLimitState.globalRateLimitUntil,
    globalRateLimitWaitTime: rateLimitState.isGloballyRateLimited 
      ? Math.max(0, rateLimitState.globalRateLimitUntil - now)
      : 0,
    adaptiveDelayMultiplier: rateLimitState.adaptiveDelayMultiplier,
    timeSinceLastRateLimit: now - rateLimitState.lastRateLimitTime,
    routeRateLimits: Array.from(rateLimitState.routeRateLimits.entries()).map(([route, data]) => ({
      route,
      remaining: data.remaining,
      resetAt: data.resetAt,
      waitTime: Math.max(0, data.resetAt - now)
    }))
  };
}

// Function to reset rate limit state (for manual intervention)
export function resetRateLimitState() {
  rateLimitState = {
    isGloballyRateLimited: false,
    globalRateLimitUntil: 0,
    routeRateLimits: new Map(),
    adaptiveDelayMultiplier: 1,
    lastRateLimitTime: 0,
  };
  console.log("🔄 Rate limit state reset");
}

// Add this utility function for Discord API calls with rate limit handling
async function discordApiCall(
  url: string,
  options: RequestInit,
): Promise<Response> {
  if (!DISCORD_TOKEN) {
    throw new Error("Missing Discord token");
  }

  const method = options.method || "GET";
  const routeKey = getRouteKey(url, method);

  // Check global rate limit
  if (rateLimitState.isGloballyRateLimited && Date.now() < rateLimitState.globalRateLimitUntil) {
    const waitTime = rateLimitState.globalRateLimitUntil - Date.now();
    console.warn(`🌍 Global rate limit active, waiting ${waitTime}ms`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
    rateLimitState.isGloballyRateLimited = false;
  }

  // Check route-specific rate limit
  const routeLimit = rateLimitState.routeRateLimits.get(routeKey);
  if (routeLimit && routeLimit.remaining <= 1 && Date.now() < routeLimit.resetAt) {
    const waitTime = routeLimit.resetAt - Date.now() + 1000; // Add 1s buffer
    console.warn(`🛣️ Route rate limit active for ${routeKey}, waiting ${waitTime}ms`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }

  // Apply adaptive delay if we've been rate limited recently
  const timeSinceLastRateLimit = Date.now() - rateLimitState.lastRateLimitTime;
  if (timeSinceLastRateLimit < SYNC_CONFIG.RATE_LIMIT_COOLDOWN) {
    const adaptiveDelay = Math.min(
      SYNC_CONFIG.DELAY_BETWEEN_ROLE_OPS * rateLimitState.adaptiveDelayMultiplier,
      SYNC_CONFIG.MAX_ADAPTIVE_DELAY
    );
    console.log(`🎯 Adaptive delay: ${adaptiveDelay}ms (multiplier: ${rateLimitState.adaptiveDelayMultiplier.toFixed(2)})`);
    await new Promise(resolve => setTimeout(resolve, adaptiveDelay));
  }

  // Set up headers
  const headers = {
    "Authorization": `Bot ${DISCORD_TOKEN}`,
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  // Maximum number of retries
  const MAX_RETRIES = 7; // Increased for better reliability
  let retries = 0;

  while (retries < MAX_RETRIES) {
    try {
      const response = await fetch(url, {
        ...options,
        headers,
      });

      // Update rate limit tracking from response headers
      const remaining = parseInt(response.headers.get("X-RateLimit-Remaining") || "50");
      const resetAfter = parseFloat(response.headers.get("X-RateLimit-Reset-After") || "1");
      const resetAt = Date.now() + (resetAfter * 1000);

      // Update route-specific rate limit info
      rateLimitState.routeRateLimits.set(routeKey, {
        remaining: remaining,
        resetAt: resetAt
      });

      // If rate limited, handle it
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get("Retry-After") || "1");
        const isGlobal = response.headers.get("X-RateLimit-Global") === "true";
        const scope = response.headers.get("X-RateLimit-Scope") || "unknown";

        // Update rate limit state
        rateLimitState.lastRateLimitTime = Date.now();
        rateLimitState.adaptiveDelayMultiplier = Math.min(
          rateLimitState.adaptiveDelayMultiplier * SYNC_CONFIG.ADAPTIVE_DELAY_MULTIPLIER,
          5 // Max 5x multiplier
        );

        if (isGlobal) {
          rateLimitState.isGloballyRateLimited = true;
          rateLimitState.globalRateLimitUntil = Date.now() + (retryAfter * 1000) + 2000; // 2s buffer
        }

        console.warn(
          `⚠️ Rate limited (${
            isGlobal ? "GLOBAL" : "route-specific"
          }, scope: ${scope}). Waiting ${retryAfter}s before retrying... (attempt ${
            retries + 1
          }/${MAX_RETRIES}) [Adaptive multiplier: ${rateLimitState.adaptiveDelayMultiplier.toFixed(2)}]`,
        );

        // Wait with extra buffer
        const waitTime = (retryAfter + (isGlobal ? 3 : 1)) * 1000;
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        retries++;
        continue;
      }

      // Reset adaptive delay on successful requests
      if (response.ok && timeSinceLastRateLimit > SYNC_CONFIG.RATE_LIMIT_COOLDOWN) {
        rateLimitState.adaptiveDelayMultiplier = Math.max(
          rateLimitState.adaptiveDelayMultiplier * 0.95, // Slowly reduce multiplier
          1 // But never below 1
        );
      }

      // Smart rate limiting based on remaining requests
      const config = SYNC_CONFIG.ACTIVE;
      const safetyThreshold = config.RATE_LIMIT_SAFETY_THRESHOLD || 3;
      
      if (remaining <= 1) {
        // Critical: Wait for reset
        console.warn(`🚨 Critical rate limit: ${remaining} remaining, waiting ${resetAfter}s for reset`);
        await new Promise(resolve => setTimeout(resolve, (resetAfter + 1) * 1000));
      } else if (remaining <= safetyThreshold) {
        // Low: Add proportional delay
        const delayMs = Math.max(200, (safetyThreshold - remaining) * 300);
        console.warn(
          `⚠️ Rate limit warning: ${remaining} requests remaining for ${routeKey}, adding ${delayMs}ms delay`,
        );
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
      // No delay if remaining > safetyThreshold (this is the aggressive part!)

      return response;
    } catch (error) {
      console.error("Error making Discord API call:", error);
      retries++;

      // Add exponential backoff for network errors
      if (retries < MAX_RETRIES) {
        const backoffDelay = Math.min(1000 * Math.pow(2, retries), 45000); // Max 45s
        console.log(
          `Network error, waiting ${backoffDelay}ms before retry ${retries}/${MAX_RETRIES}`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoffDelay));
        continue;
      }

      throw error;
    }
  }

  throw new Error(`Failed after ${MAX_RETRIES} retries due to rate limiting`);
}

// Update assignRoleToUser to use the new function
async function assignRoleToUser(
  guildId: string,
  userId: string,
  roleId: string,
) {
  try {
    const url =
      `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`;

    const response = await discordApiCall(url, {
      method: "PUT",
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error(`Failed to assign role: ${response.status} ${errorData}`);
      return {
        success: false,
        error: `Failed to assign role: ${response.status}`,
      };
    }

    return { success: true };
  } catch (error) {
    console.error("Error assigning role:", error);
    return {
      success: false,
      error: `Error assigning role: ${error}`,
    };
  }
}

// Function to send follow-up message after deferred response
async function sendFollowUpMessage(
  interactionId: string,
  interactionToken: string,
  content: string,
): Promise<void> {
  try {
    const url = `https://discord.com/api/v10/webhooks/${APPLICATION_ID}/${interactionToken}`;

    const response = await discordApiCall(url, {
      method: "POST",
      body: JSON.stringify({
        content,
        flags: 64, // Ephemeral message
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error(`Failed to send follow-up message: ${response.status} ${errorData}`);
      throw new Error(`Failed to send follow-up message: ${response.status}`);
    }
  } catch (error) {
    console.error("Error sending follow-up message:", error);
    throw error;
  }
}

// Function to send follow-up embed message after deferred response
async function sendFollowUpEmbedMessage(
  interactionId: string,
  interactionToken: string,
  embed: any,
): Promise<void> {
  try {
    const url = `https://discord.com/api/v10/webhooks/${APPLICATION_ID}/${interactionToken}`;

    const response = await discordApiCall(url, {
      method: "POST",
      body: JSON.stringify({
        embeds: [embed],
        flags: 64, // Ephemeral message
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error(`Failed to send follow-up embed: ${response.status} ${errorData}`);
      throw new Error(`Failed to send follow-up embed: ${response.status}`);
    }
  } catch (error) {
    console.error("Error sending follow-up embed message:", error);
    throw error;
  }
}

// Function to send public follow-up embed message after deferred response
async function sendPublicFollowUpEmbedMessage(
  interactionId: string,
  interactionToken: string,
  embed: any,
): Promise<void> {
  try {
    const url = `https://discord.com/api/v10/webhooks/${APPLICATION_ID}/${interactionToken}`;

    const response = await discordApiCall(url, {
      method: "POST",
      body: JSON.stringify({
        embeds: [embed],
        // No flags = public message
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error(`Failed to send public follow-up embed: ${response.status} ${errorData}`);
      throw new Error(`Failed to send public follow-up embed: ${response.status}`);
    }
  } catch (error) {
    console.error("Error sending public follow-up embed message:", error);
    throw error;
  }
}

// Function to send public follow-up message after deferred response
async function sendPublicFollowUpMessage(
  interactionId: string,
  interactionToken: string,
  content: string,
): Promise<void> {
  try {
    const url = `https://discord.com/api/v10/webhooks/${APPLICATION_ID}/${interactionToken}`;

    const response = await discordApiCall(url, {
      method: "POST",
      body: JSON.stringify({
        content,
        // No flags = public message
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error(`Failed to send public follow-up message: ${response.status} ${errorData}`);
      throw new Error(`Failed to send public follow-up message: ${response.status}`);
    }
  } catch (error) {
    console.error("Error sending public follow-up message:", error);
    throw error;
  }
}

// Helper function to safely send follow-up messages with token check
async function safeFollowUp(
  interaction: { id: string; token?: string },
  content: string,
): Promise<void> {
  if (interaction.token) {
    await sendFollowUpMessage(interaction.id, interaction.token, content);
  }
}

// Helper function to safely send follow-up embeds with token check
async function safeFollowUpEmbed(
  interaction: { id: string; token?: string },
  embed: any,
): Promise<void> {
  if (interaction.token) {
    await sendFollowUpEmbedMessage(interaction.id, interaction.token, embed);
  }
}

// Function to send webhook notification for role changes
async function sendRoleChangeWebhook(
  userId: string,
  changes: string[],
  context: "user-initiated" | "batch-sync" | "validator-check" | "individual-sync" | "recalc-command",
  additionalInfo?: {
    userScore?: number;
    profileInfo?: string;
    guildId?: string;
    processedCount?: number;
    totalCount?: number;
    triggeredBy?: string;
  }
): Promise<void> {
  if (!WEBHOOK_URL || changes.length === 0) return;

  try {
    // Create context-specific message
    let title = "";
    let description = "";
    let color = 0x2E7BC3; // Default blue
    let footer = "";

    switch (context) {
      case "user-initiated":
        title = "🔒 User Verification";
        description = `User <@${userId}> manually verified their roles`;
        color = 0x127F31; // Green
        footer = "Manual verification via @mention";
        break;
      
      case "batch-sync":
        title = "⚙️ Batch Role Sync";
        description = `Roles updated for user <@${userId}> during batch sync`;
        color = 0x2E7BC3; // Blue
        footer = additionalInfo?.processedCount && additionalInfo?.totalCount 
          ? `Batch sync progress: ${additionalInfo.processedCount}/${additionalInfo.totalCount}`
          : "Automated batch synchronization";
        break;
      
      case "validator-check":
        title = "🛡️ Validator Verification";
        description = `Validator roles updated for user <@${userId}>`;
        color = 0xCC9A1A; // Yellow
        footer = "Automated validator NFT verification";
        break;
      
      case "individual-sync":
        title = "🔄 Individual Sync";
        description = `Roles updated for user <@${userId}> during individual sync`;
        color = 0xC1C0B6; // Gray
        footer = "Individual role synchronization";
        break;

      case "recalc-command":
        title = "📊 Role Recalculation";
        description = `Roles corrected for user <@${userId}> during high-score recalculation`;
        color = 0x9B59B6; // Purple
        footer = additionalInfo?.triggeredBy
          ? `Recalculation triggered by <@${additionalInfo.triggeredBy}>`
          : "Admin-triggered role recalculation";
        break;
    }

    // Add score information if available
    if (additionalInfo?.userScore !== undefined) {
      const scoreName = getRoleNameForScore(additionalInfo.userScore);
      description += `\n**Score:** ${additionalInfo.userScore} (${scoreName})`;
    }

    // Add profile info if available
    if (additionalInfo?.profileInfo) {
      description += `\n**Profile:** ${additionalInfo.profileInfo}`;
    }

    const embed = {
      title,
      description,
      color,
      fields: [
        {
          name: "Role Changes",
          value: changes.join("\n"),
          inline: false,
        },
      ],
      footer: {
        text: footer,
      },
      timestamp: new Date().toISOString(),
    };

    // Add guild info if available
    if (additionalInfo?.guildId) {
      embed.fields.push({
        name: "Guild ID",
        value: additionalInfo.guildId,
        inline: true,
      });
    }

    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        embeds: [embed],
        username: "Ethos Role Manager",
        avatar_url: "https://app.ethos.network/favicon.ico",
      }),
    });

    if (!response.ok) {
      console.error(`Failed to send webhook notification: ${response.status} ${response.statusText}`);
    } else {
      console.log(`📢 Webhook notification sent for user ${userId} (${context})`);
    }
  } catch (error) {
    console.error("Error sending webhook notification:", error);
  }
}

// Function to fetch Ethos profile by Discord user ID
async function fetchEthosProfileByDiscord(
  userId: string,
  discordAvatarUrl?: string,
) {
  try {
    console.log("Looking up Discord user with ID:", userId);

    // Make sure we're just using the raw ID without any @ symbol
    const cleanUserId = userId.replace("@", "").replace("<", "").replace(
      ">",
      "",
    );
    console.log("Clean User ID:", cleanUserId);

    // Use the Ethos API with the Discord ID - ensure proper format
    const userkey = `service:discord:${cleanUserId}`;

    // First fetch the user's addresses to get their primary Ethereum address
    const addressResponse = await fetch(
      `https://api.ethos.network/api/v1/addresses/${userkey}`,
      {
        headers: {
          "X-Ethos-Client": "ethos-discord",
        },
      },
    );
    const addressData = await addressResponse.json();
    console.log("Address API Response:", JSON.stringify(addressData, null, 2));

    let primaryAddress = null;
    if (addressData.ok && addressData.data?.primaryAddress) {
      primaryAddress = addressData.data.primaryAddress;
      // Check if it's the zero address (0x0000...)
      if (primaryAddress === "0x0000000000000000000000000000000000000000") {
        primaryAddress = null;
      }
    }

    console.log("Primary Address:", primaryAddress);

    // Fetch profile score and user statistics using the API endpoint
    const [profileResponse, userStatsResponse, topReviewResponse] =
      await Promise.all([
        fetch(`https://api.ethos.network/api/v1/score/${userkey}`, {
          headers: {
            "X-Ethos-Client": "ethos-discord",
          },
        }),
        fetch(`https://api.ethos.network/api/v1/users/${userkey}/stats`, {
          headers: {
            "X-Ethos-Client": "ethos-discord",
          },
        }),
        fetch(`https://api.ethos.network/api/v2/activities/profile/received`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Ethos-Client": "ethos-discord",
          },
          body: JSON.stringify({
            userkey,
            filter: ["review"],
            excludeHistorical: true,
            orderBy: { field: "votes", direction: "desc" },
            limit: 1,
            offset: 0,
          }),
        }),
      ]);

    if (!profileResponse.ok) {
      if (profileResponse.status === 404) {
        return {
          error:
            `No Ethos profile found for Discord user with ID '${cleanUserId}'. They either don't have a profile or haven't connected Discord to their Ethos account.`,
        };
      }
      return { error: "Failed to fetch profile. Please try again later." };
    }

    const profileData = await profileResponse.json();
    console.log("Profile API Response:", JSON.stringify(profileData, null, 2));

    if (!profileData.ok || !profileData.data) {
      return {
        error:
          "This profile hasn't been indexed by Ethos yet. Please try again later.",
      };
    }

    const userStats = await userStatsResponse.json();
    console.log("User Stats API Response:", JSON.stringify(userStats, null, 2));

    const topReviewResponseData = await topReviewResponse.json();
    console.log(
      "Top Review Response:",
      JSON.stringify(topReviewResponseData, null, 2),
    );

    // v2 response: values is at top-level (no ok/data wrapper)
    const topReviewItem = topReviewResponseData?.values?.[0];
    const topReviewData = topReviewItem?.data;

    // Extract review stats from the new unified response
    const totalReviews = userStats.ok
      ? userStats.data?.reviews?.received || 0
      : 0;
    const positiveReviewCount = userStats.ok
      ? userStats.data?.reviews?.positiveReviewCount || 0
      : 0;
    const negativeReviewCount = userStats.ok
      ? userStats.data?.reviews?.negativeReviewCount || 0
      : 0;
    const positivePercentage = userStats.ok
      ? userStats.data?.reviews?.positiveReviewPercentage || 0
      : 0;

    // Extract vouch stats from the new unified response
    const vouchCount = userStats.ok
      ? userStats.data?.vouches?.count?.received || 0
      : 0;
    const vouchBalance = userStats.ok
      ? Number(userStats.data?.vouches?.balance?.received || 0).toFixed(2)
      : "0.00";
    const mutualVouches = userStats.ok
      ? userStats.data?.vouches?.count?.mutual || 0
      : 0;
    const influenceFactor = userStats.ok
      ? userStats.data?.influenceFactor ?? null
      : null;

    const scoreData = profileData.data;
    const elements = scoreData.elements || {};

    return {
      score: scoreData.score,
      handle: cleanUserId, // Use the clean user ID as the handle
      userId: cleanUserId,
      avatar: discordAvatarUrl || scoreData.avatar ||
        "https://cdn.discordapp.com/embed/avatars/0.png", // Use Discord avatar if provided
      name: scoreData.name || `Discord User ${cleanUserId}`,
      service: "discord",
      primaryAddress,
      influenceFactor,
      elements: {
        accountAge: elements["Discord Account Age"]?.raw,
        ethAge: elements["Ethereum Address Age"]?.raw,
        vouchCount,
        vouchBalance,
        totalReviews,
        positivePercentage,
        mutualVouches,
      },
      topReview: topReviewData
        ? {
          comment: topReviewData.comment,
          score: topReviewData.score,
          upvotes: (topReviewItem?.votes?.upvotes ?? 0),
          authorName: (topReviewItem?.author?.name ?? "Unknown"),
        }
        : null,
      // Verification status, XP, and influence (fetched inline from v2 API)
      ...(await (async () => {
        try {
          const status = await getUserVerificationStatus(cleanUserId);
          return {
            isHumanVerified: status.isHumanVerified,
            hasValidator: status.hasValidator,
            xpTotal: status.xpTotal,
            ...(status.influenceFactor != null ? { influenceFactor: status.influenceFactor } : {}),
          };
        } catch { return { isHumanVerified: false, hasValidator: false, xpTotal: null }; }
      })()),
    };
  } catch (error) {
    console.error("Error fetching Ethos profile by Discord:", error);
    return {
      error:
        "Something went wrong while fetching the profile. Please try again later.",
    };
  }
}

// Function to fetch Ethos profile by Twitter handle
async function fetchEthosProfileByTwitter(handle: string) {
  try {
    // Format handle for x.com service
    const formattedHandle = handle.replace("@", "");

    // First fetch Twitter ID
    const twitterResponse = await fetch(
      `https://api.ethos.network/api/twitter/user/?username=${formattedHandle}`,
      {
        headers: {
          "X-Ethos-Client": "ethos-discord",
        },
      },
    );
    if (!twitterResponse.ok) {
      if (twitterResponse.status === 404) {
        return { error: `Twitter handle @${formattedHandle} not found` };
      }
      return { error: "Failed to fetch Twitter info. Please try again later." };
    }

    const twitterData = await twitterResponse.json();
    console.log("Twitter API Response:", JSON.stringify(twitterData, null, 2));

    if (!twitterData.ok || !twitterData.data?.id) {
      return { error: "Could not find Twitter ID for this handle" };
    }

    const twitterId = twitterData.data.id;
    const userkey = `service:x.com:${twitterId}`;

    // Fetch profile score and user statistics using the new API endpoint
    const [profileResponse, userStatsResponse, topReviewResponse, v2UserResponse] =
      await Promise.all([
        fetch(`https://api.ethos.network/api/v1/score/${userkey}`, {
          headers: {
            "X-Ethos-Client": "ethos-discord",
          },
        }),
        fetch(`https://api.ethos.network/api/v1/users/${userkey}/stats`, {
          headers: {
            "X-Ethos-Client": "ethos-discord",
          },
        }),
        fetch(`https://api.ethos.network/api/v2/activities/profile/received`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Ethos-Client": "ethos-discord",
          },
          body: JSON.stringify({
            userkey,
            filter: ["review"],
            excludeHistorical: true,
            orderBy: { field: "votes", direction: "desc" },
            limit: 1,
            offset: 0,
          }),
        }),
        fetch(`https://api.ethos.network/api/v2/user/by/x/${encodeURIComponent(formattedHandle)}`, {
          headers: {
            "X-Ethos-Client": "ethos-discord",
          },
        }),
      ]);

    if (!profileResponse.ok) {
      if (profileResponse.status === 404) {
        return { error: `No Ethos profile found for @${formattedHandle}.` };
      }
      return { error: "Failed to fetch profile. Please try again later." };
    }

    const profileData = await profileResponse.json();
    console.log("Profile API Response:", JSON.stringify(profileData, null, 2));

    if (!profileData.ok || !profileData.data) {
      return {
        error:
          "This profile hasn't been indexed by Ethos yet. Please try again later.",
      };
    }

    const userStats = await userStatsResponse.json();
    console.log("User Stats API Response:", JSON.stringify(userStats, null, 2));

    // Extract XP from v2 user endpoint
    let xpTotal: number | null = null;
    try {
      if (v2UserResponse.ok) {
        const v2Data = await v2UserResponse.json();
        xpTotal = v2Data.xpTotal ?? null;
      }
    } catch { /* ignore v2 user fetch errors */ }

    const topReviewResponseData = await topReviewResponse.json();
    console.log(
      "Top Review Response:",
      JSON.stringify(topReviewResponseData, null, 2),
    );

    // v2 response: values is at top-level
    const topReviewItem = topReviewResponseData?.values?.[0];
    const topReviewData = topReviewItem?.data;

    // Extract review stats from the new unified response
    const totalReviews = userStats.ok
      ? userStats.data?.reviews?.received || 0
      : 0;
    const positiveReviewCount = userStats.ok
      ? userStats.data?.reviews?.positiveReviewCount || 0
      : 0;
    const negativeReviewCount = userStats.ok
      ? userStats.data?.reviews?.negativeReviewCount || 0
      : 0;
    const positivePercentage = userStats.ok
      ? userStats.data?.reviews?.positiveReviewPercentage || 0
      : 0;

    // Extract vouch stats from the new unified response
    const vouchCount = userStats.ok
      ? userStats.data?.vouches?.count?.received || 0
      : 0;
    const vouchBalance = userStats.ok
      ? Number(userStats.data?.vouches?.balance?.received || 0).toFixed(2)
      : "0.00";
    const mutualVouches = userStats.ok
      ? userStats.data?.vouches?.count?.mutual || 0
      : 0;
    const influenceFactor = userStats.ok
      ? userStats.data?.influenceFactor ?? null
      : null;

    const scoreData = profileData.data;
    const elements = scoreData.elements || {};

    return {
      score: scoreData.score,
      handle: formattedHandle,
      twitterId,
      avatar: twitterData.data.avatar,
      name: twitterData.data.name,
      service: "twitter",
      influenceFactor,
      xpTotal,
      elements: {
        accountAge: elements["Twitter Account Age"]?.raw,
        ethAge: elements["Ethereum Address Age"]?.raw,
        vouchCount,
        vouchBalance,
        totalReviews,
        positivePercentage,
        mutualVouches,
      },
      topReview: topReviewData
        ? {
          comment: topReviewData.comment,
          score: topReviewData.score,
          upvotes: (topReviewItem?.votes?.upvotes ?? 0),
          authorName: (topReviewItem?.author?.name ?? "Unknown"),
        }
        : null,
    };
  } catch (error) {
    console.error("Error fetching Ethos profile by Twitter:", error);
    return {
      error:
        "Something went wrong while fetching the profile. Please try again later.",
    };
  }
}

// Function to fetch Ethos profile
async function fetchEthosProfile(handle: string) {
  // Detect if handle is a Discord handle or Twitter handle
  if (isDiscordHandle(handle)) {
    return fetchEthosProfileByDiscord(handle);
  } else {
    return fetchEthosProfileByTwitter(handle);
  }
}

// Helper function to convert hex to Uint8Array
function hexToUint8Array(hex: string): Uint8Array {
  return new Uint8Array(
    hex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || [],
  );
}

// Verify the request is from Discord
async function verifyRequest(request: Request): Promise<APIInteraction | null> {
  console.log("Received request:", request.method);
  console.log("Headers:", Object.fromEntries(request.headers.entries()));

  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");

  if (!signature || !timestamp) {
    console.error("Missing signature or timestamp");
    console.error("signature:", signature);
    console.error("timestamp:", timestamp);
    return null;
  }

  const body = await request.text();
  console.log("Request body:", body);

  try {
    console.log("Using public key:", PUBLIC_KEY);

    const key = await crypto.subtle.importKey(
      "raw",
      hexToUint8Array(PUBLIC_KEY || ""),
      {
        name: "Ed25519",
      },
      false,
      ["verify"],
    );

    const signatureUint8 = hexToUint8Array(signature);
    const timestampAndBody = new TextEncoder().encode(timestamp + body);

    console.log("Signature length:", signatureUint8.length);
    console.log("Message length:", timestampAndBody.length);

    const isValid = await crypto.subtle.verify(
      {
        name: "Ed25519",
      },
      key,
      signatureUint8,
      timestampAndBody,
    );

    console.log("Signature verification result:", isValid);

    if (!isValid) {
      console.error("Invalid signature");
      return null;
    }

    return JSON.parse(body);
  } catch (error) {
    console.error("Error verifying request:", error);
    return null;
  }
}

// Function to get role ID based on score (regular roles) - Updated for new scoring system
// Get the tier for a given score (iterates highest-first)
function getTierForScore(score: number): { name: string; minScore: number; color: number } {
  for (const tier of SCORE_TIERS) {
    if (score >= tier.minScore) return tier;
  }
  return SCORE_TIERS[SCORE_TIERS.length - 1]; // Untrusted fallback
}

// Get role ID from roleRegistry for a score + variant
function getRoleIdForScore(score: number, variant = "base"): string | null {
  const tier = getTierForScore(score);
  // Untrusted only gets base variant
  if (tier.name === "Untrusted" && variant !== "base") return null;
  const key = `${tier.name}:${variant}`;
  return roleRegistry.get(key) || LEGACY_ROLE_IDS[key] || null;
}



function getRoleNameForScore(score: number): string {
  return getTierForScore(score).name;
}

// Handle Discord interactions
async function handleInteraction(
  interaction: APIInteraction,
): Promise<APIInteractionResponse> {
  switch (interaction.type) {
    // Respond to ping from Discord
    case InteractionType.Ping:
      return {
        type: InteractionResponseType.Pong,
      };

    // Handle slash commands
    case InteractionType.ApplicationCommand: {
      const commandName = interaction.data?.name;

      // Handle ethos command (Discord profiles)
      if (commandName === "ethos") {
        const userId = interaction.data.options?.[0].value?.toString();
        if (!userId) {
          return {
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
              content: "Please mention a Discord user!",
              flags: 64, // Ephemeral
            },
          };
        }

        // Immediately respond with "thinking" to prevent timeout
        const deferredResponse = {
          type: InteractionResponseType.DeferredChannelMessageWithSource,
          data: {
            flags: 0, // Explicitly set to 0 for public message
          },
        };

        // Process asynchronously and send follow-up
        (async () => {
          try {
            console.log("Discord user ID from interaction:", userId);

            const userData = interaction.data.resolved?.users?.[userId];
            const username = userData?.username || "Unknown User";
            const displayName = userData?.global_name || username;

            let avatarUrl: string | undefined = undefined;
            if (userData?.avatar) {
              avatarUrl = `https://cdn.discordapp.com/avatars/${userId}/${userData.avatar}.png`;
            }

            const profile = await fetchEthosProfileByDiscord(userId, avatarUrl);

            if ("error" in profile) {
              await sendPublicFollowUpMessage(interaction.id, interaction.token, profile.error);
              return;
            }

            const title = `Ethos profile for ${displayName}`;

            let profileUrl;
            if (profile.primaryAddress) {
              profileUrl = `https://app.ethos.network/profile/${profile.primaryAddress}?src=discord-agent`;
            } else {
              profileUrl = `https://app.ethos.network/profile/discord/${profile.userId}?src=discord-agent`;
            }

            await sendPublicFollowUpEmbedMessage(interaction.id, interaction.token, {
              title,
              url: profileUrl,
              description: `${displayName} is considered **${getScoreLabel(profile.score)}**.${getStatusBadges(profile)}`,
              color: getScoreColor(profile.score),
              thumbnail: {
                url: avatarUrl || profile.avatar || "https://cdn.discordapp.com/embed/avatars/0.png",
              },
              fields: [
                {
                  name: "Ethos score",
                  value: String(profile.score ?? "N/A"),
                  inline: true,
                },
                {
                  name: "Reviews",
                  value: `${profile.elements?.totalReviews} (${profile.elements?.positivePercentage?.toFixed(2)}% positive)`,
                  inline: true,
                },
                {
                  name: "Vouched",
                  value: `${profile.elements?.vouchBalance}e (${profile.elements?.vouchCount} vouchers)`,
                  inline: true,
                },
                ...(profile.influenceFactor != null
                  ? [{
                    name: "Influence factor",
                    value: String(profile.influenceFactor),
                    inline: true,
                  }]
                  : []),
                ...(profile.xpTotal != null
                  ? [{
                    name: "Contributor XP",
                    value: Number(profile.xpTotal).toLocaleString(),
                    inline: true,
                  }]
                  : []),
                ...(profile.topReview
                  ? [{
                    name: "Most upvoted review",
                    value: `*"${profile.topReview.comment}"* - ${profile.topReview.authorName} (${profile.topReview.upvotes} upvotes)`,
                    inline: false,
                  }]
                  : []),
              ],
              footer: {
                text: "Data from https://app.ethos.network",
              },
              timestamp: new Date().toISOString(),
            });
          } catch (error) {
            console.error("Error in async ethos command:", error);
            try {
              await sendPublicFollowUpMessage(interaction.id, interaction.token,
                "❌ An error occurred while fetching the profile. Please try again later.");
            } catch (followUpError) {
              console.error("Error sending follow-up message:", followUpError);
            }
          }
        })();

        return deferredResponse;
      } // Handle ethosx command (Twitter profiles)
      else if (commandName === "ethosx") {
        const twitterHandle = interaction.data.options?.[0].value?.toString();
        if (!twitterHandle) {
          return {
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
              content: "Please provide a Twitter handle!",
              flags: 64, // Ephemeral
            },
          };
        }

        // Immediately respond with "thinking" to prevent timeout
        const deferredResponse = {
          type: InteractionResponseType.DeferredChannelMessageWithSource,
          data: {
            flags: 0, // Explicitly set to 0 for public message
          },
        };

        // Process asynchronously and send follow-up
        (async () => {
          try {
            const profile = await fetchEthosProfileByTwitter(twitterHandle);

            if ("error" in profile) {
              await sendPublicFollowUpMessage(interaction.id, interaction.token, profile.error);
              return;
            }

            const title = `Ethos profile for @${profile.handle}`;
            const profileUrl =
              `https://app.ethos.network/profile/x/${profile.handle}?src=discord-agent`;

            // Send follow-up with embed (public)
            await sendPublicFollowUpEmbedMessage(interaction.id, interaction.token, {
              title,
              url: profileUrl,
              description: `${profile.name} is considered **${
                getScoreLabel(profile.score)
              }**.`,
              color: getScoreColor(profile.score),
              thumbnail: {
                url: profile.avatar,
              },
              fields: [
                {
                  name: "Ethos score",
                  value: String(profile.score ?? "N/A"),
                  inline: true,
                },
                {
                  name: "Reviews",
                  value: `${profile.elements?.totalReviews} (${
                    profile.elements?.positivePercentage?.toFixed(2)
                  }% positive)`,
                  inline: true,
                },
                {
                  name: "Vouched",
                  value:
                    `${profile.elements?.vouchBalance}e (${profile.elements?.vouchCount} vouchers)`,
                  inline: true,
                },
                ...(profile.influenceFactor != null
                  ? [{
                    name: "Influence factor",
                    value: String(profile.influenceFactor),
                    inline: true,
                  }]
                  : []),
                ...(profile.xpTotal != null
                  ? [{
                    name: "Contributor XP",
                    value: Number(profile.xpTotal).toLocaleString(),
                    inline: true,
                  }]
                  : []),
                ...(profile.topReview
                  ? [{
                    name: "Most upvoted review",
                    value:
                      `*"${profile.topReview.comment}"* - ${profile.topReview.authorName} (${profile.topReview.upvotes} upvotes)`,
                    inline: false,
                  }]
                  : []),
              ],
              footer: {
                text: "Data from https://app.ethos.network",
              },
              timestamp: new Date().toISOString(),
            });

          } catch (error) {
            console.error("Error in async ethosx command:", error);
            
            try {
              await sendPublicFollowUpMessage(interaction.id, interaction.token, 
                "❌ An error occurred while fetching the profile. Please try again later.");
            } catch (followUpError) {
              console.error("Error sending follow-up message:", followUpError);
            }
          }
        })();

        return deferredResponse;
      } // Unknown command
      else {
        return {
          type: InteractionResponseType.ChannelMessageWithSource,
          data: {
            content: "Unknown command",
            flags: 64, // Ephemeral
          },
        };
      }
    }

    default:
      return {
        type: InteractionResponseType.ChannelMessageWithSource,
        data: {
          content: "Unsupported interaction type",
          flags: 64, // Ephemeral
        },
      };
  }
}

// Build status badges string for embed descriptions (label + icon on a new line)
function getStatusBadges(profile: { isHumanVerified?: boolean; hasValidator?: boolean }): string {
  if (profile.isHumanVerified && profile.hasValidator) {
    const emoji = emojiRegistry.get("verified_validator");
    return emoji ? `\nIs a Human Validator ${emoji}` : "\nIs a Human Validator";
  }
  if (profile.isHumanVerified) {
    const emoji = emojiRegistry.get("human_verified_silver") || emojiRegistry.get("human_verified_badge");
    return emoji ? `\nIs human ${emoji}` : "\nIs human";
  }
  if (profile.hasValidator) {
    const emoji = emojiRegistry.get("validator");
    return emoji ? `\nOwns a validator ${emoji}` : "\nOwns a validator";
  }
  return "";
}

function getScoreLabel(score: number): string {
  return getTierForScore(score).name.toLowerCase();
}

function getScoreColor(score: number): number {
  return getTierForScore(score).color;
}

// ===== DISCORD GATEWAY WEBSOCKET =====
// Allows the bot to receive MESSAGE_CREATE events for @mention support.

const GatewayOp = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

// Intents: GUILDS (1<<0) | GUILD_MESSAGES (1<<9) | MESSAGE_CONTENT (1<<15)
const GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 15); // 33281

// Mutable Gateway state
let gatewayWs: WebSocket | null = null;
let gatewaySessionId: string | null = null;
let gatewayResumeUrl: string | null = null;
let gatewaySequence: number | null = null;
let gatewayHeartbeatTimer: number | null = null;
let gatewayHeartbeatAcked = true;
let gatewayBotUserId: string | null = null;
let gatewayReconnectAttempts = 0;

// Non-recoverable close codes — do not reconnect
const GATEWAY_FATAL_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

async function fetchGatewayUrl(): Promise<string> {
  const response = await discordApiCall(
    "https://discord.com/api/v10/gateway/bot",
    { method: "GET" },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch Gateway URL: ${response.status} ${text}`);
  }
  const data = await response.json();
  return `${data.url}?v=10&encoding=json`;
}

async function connectGateway(): Promise<void> {
  if (!DISCORD_TOKEN) {
    console.warn("⚠️ DISCORD_TOKEN not set — Gateway WebSocket disabled (no @mention support)");
    return;
  }

  try {
    const url = gatewayResumeUrl ?? await fetchGatewayUrl();
    console.log(`🔌 Connecting to Discord Gateway: ${url}`);

    const ws = new WebSocket(url);
    gatewayWs = ws;

    ws.onopen = () => {
      console.log("✅ Gateway WebSocket connected");
      gatewayReconnectAttempts = 0;
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data as string);
        handleGatewayMessage(payload);
      } catch (error) {
        console.error("❌ Failed to parse Gateway message:", error);
      }
    };

    ws.onerror = (event) => {
      console.error("❌ Gateway WebSocket error:", event);
    };

    ws.onclose = (event) => {
      clearGatewayHeartbeat();
      gatewayWs = null;

      console.warn(`🔌 Gateway closed: code=${event.code} reason="${event.reason}"`);

      if (GATEWAY_FATAL_CODES.has(event.code)) {
        let hint = "";
        if (event.code === 4004) hint = " (invalid token)";
        if (event.code === 4014) hint = " — enable MESSAGE_CONTENT intent in Discord Developer Portal";
        console.error(`🚫 Fatal Gateway close code ${event.code}${hint}. Not reconnecting.`);
        return;
      }

      // Invalidate session on certain codes so we don't try to Resume
      if (event.code === 4007 || event.code === 4009) {
        gatewaySessionId = null;
        gatewaySequence = null;
      }

      scheduleGatewayReconnect();
    };
  } catch (error) {
    console.error("❌ Gateway connection error:", error);
    scheduleGatewayReconnect();
  }
}

function handleGatewayMessage(payload: { op: number; d: any; s: number | null; t: string | null }) {
  // Track sequence for heartbeats and Resume
  if (payload.s !== null) {
    gatewaySequence = payload.s;
  }

  switch (payload.op) {
    case GatewayOp.HELLO:
      handleGatewayHello(payload.d);
      break;
    case GatewayOp.HEARTBEAT_ACK:
      gatewayHeartbeatAcked = true;
      break;
    case GatewayOp.HEARTBEAT:
      // Server requested an immediate heartbeat
      sendGatewayHeartbeat();
      break;
    case GatewayOp.RECONNECT:
      console.log("🔄 Gateway requested reconnect");
      gatewayWs?.close(4000, "Reconnect requested");
      break;
    case GatewayOp.INVALID_SESSION:
      console.warn("⚠️ Invalid session, resumable:", payload.d);
      if (!payload.d) {
        // Not resumable — clear session and reconnect fresh
        gatewaySessionId = null;
        gatewaySequence = null;
        gatewayResumeUrl = null;
      }
      setTimeout(() => {
        gatewayWs?.close(4000, "Invalid session");
      }, 1000 + Math.random() * 4000);
      break;
    case GatewayOp.DISPATCH:
      handleGatewayDispatch(payload.t!, payload.d);
      break;
  }
}

function handleGatewayHello(d: { heartbeat_interval: number }) {
  const intervalMs = d.heartbeat_interval;
  console.log(`💓 Gateway heartbeat interval: ${intervalMs}ms`);

  // Start heartbeat with initial jitter
  const jitter = Math.random() * intervalMs;
  setTimeout(() => {
    sendGatewayHeartbeat();
    startGatewayHeartbeat(intervalMs);
  }, jitter);

  // Send Identify or Resume
  if (gatewaySessionId && gatewaySequence !== null) {
    console.log("🔄 Resuming Gateway session:", gatewaySessionId);
    sendGatewayPayload(GatewayOp.RESUME, {
      token: DISCORD_TOKEN,
      session_id: gatewaySessionId,
      seq: gatewaySequence,
    });
  } else {
    console.log("🆔 Sending Gateway Identify");
    sendGatewayPayload(GatewayOp.IDENTIFY, {
      token: DISCORD_TOKEN,
      intents: GATEWAY_INTENTS,
      properties: {
        os: "linux",
        browser: "ethos-bot",
        device: "ethos-bot",
      },
    });
  }
}

function startGatewayHeartbeat(intervalMs: number) {
  clearGatewayHeartbeat();
  gatewayHeartbeatTimer = setInterval(() => {
    if (!gatewayHeartbeatAcked) {
      console.warn("💔 Gateway heartbeat not ACKed — zombie connection, closing");
      gatewayWs?.close(4000, "Heartbeat timeout");
      return;
    }
    sendGatewayHeartbeat();
  }, intervalMs) as unknown as number;
}

function clearGatewayHeartbeat() {
  if (gatewayHeartbeatTimer !== null) {
    clearInterval(gatewayHeartbeatTimer);
    gatewayHeartbeatTimer = null;
  }
}

function sendGatewayHeartbeat() {
  gatewayHeartbeatAcked = false;
  sendGatewayPayload(GatewayOp.HEARTBEAT, gatewaySequence);
}

function sendGatewayPayload(op: number, d: unknown) {
  if (gatewayWs && gatewayWs.readyState === WebSocket.OPEN) {
    gatewayWs.send(JSON.stringify({ op, d }));
  }
}

function handleGatewayDispatch(eventName: string, data: any) {
  switch (eventName) {
    case "READY":
      gatewaySessionId = data.session_id;
      gatewayResumeUrl = data.resume_gateway_url
        ? `${data.resume_gateway_url}?v=10&encoding=json`
        : null;
      gatewayBotUserId = data.user?.id ?? null;
      console.log(`✅ Gateway READY — bot user ID: ${gatewayBotUserId}, session: ${gatewaySessionId}`);

      // Initialize score roles on startup
      {
        const guildId = Deno.env.get("DISCORD_GUILD_ID");
        if (guildId) {
          roleInitPromise = initializeRoles(guildId).catch((err) => {
            console.error("[ROLE-INIT] Failed to initialize roles on startup:", err);
          });
        } else {
          console.warn("[ROLE-INIT] DISCORD_GUILD_ID not set — skipping role initialization");
        }
      }
      break;
    case "RESUMED":
      console.log("✅ Gateway session resumed");
      break;
    case "MESSAGE_CREATE":
      handleGatewayMessageCreate(data);
      break;
  }
}

function scheduleGatewayReconnect() {
  gatewayReconnectAttempts++;
  const baseDelay = Math.min(1000 * Math.pow(2, gatewayReconnectAttempts - 1), 60000);
  const jitter = baseDelay * 0.25 * Math.random();
  const delay = baseDelay + jitter;
  console.log(`🔄 Gateway reconnect attempt #${gatewayReconnectAttempts} in ${Math.round(delay)}ms`);
  setTimeout(() => {
    connectGateway().catch((error) => {
      console.error("❌ Gateway reconnect failed:", error);
    });
  }, delay);
}

// ===== @MENTION HANDLER =====

function handleGatewayMessageCreate(message: any) {
  // Ignore messages from bots
  if (message.author?.bot) return;

  // Check if the bot is mentioned
  if (!gatewayBotUserId) return;
  const mentions: any[] = message.mentions ?? [];
  const isMentioned = mentions.some((m: any) => m.id === gatewayBotUserId);
  if (!isMentioned) return;

  console.log(`📩 @mention received from ${message.author?.username} in channel ${message.channel_id}`);

  // Strip the bot mention(s) to extract the question
  const mentionPattern = new RegExp(`<@!?${gatewayBotUserId}>`, "g");
  const question = message.content.replace(mentionPattern, "").trim();

  console.log(`📩 Question: "${question}" | ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY ? "set" : "MISSING"} | INTERCOM_ACCESS_TOKEN: ${INTERCOM_ACCESS_TOKEN ? "set" : "MISSING"}`);

  // Check for user mention-based Ethos profile lookups
  // When replying with a question, exclude the replied-to author from mentions
  // (Discord auto-adds the replied-to user to the mentions array)
  const replyAuthorId = message.referenced_message?.author?.id;
  const userMentions = mentions.filter((m: any) =>
    m.id !== gatewayBotUserId &&
    !(question && replyAuthorId && m.id === replyAuthorId)
  );

  let ethosTargetUsers: Array<{ id: string; username: string; global_name?: string; avatar?: string }> = [];

  if (userMentions.length > 0) {
    // Explicit @mentions alongside bot mention
    ethosTargetUsers = userMentions;
  } else if (message.referenced_message && !question) {
    // Reply with just @EthosBot — look up replied-to author
    const replyAuthor = message.referenced_message.author;
    if (replyAuthor && !replyAuthor.bot) {
      ethosTargetUsers = [replyAuthor];
    }
  }

  // Check for "verify @target" — sync another user's roles
  if (ethosTargetUsers.length > 0 && question.replace(/<@!?\d+>/g, "").trim().toLowerCase() === "verify") {
    const guildId = message.guild_id;
    if (!guildId) {
      sendGatewayChannelMessage(
        message.channel_id,
        "This command can only be used in a server.",
        message.id,
      ).catch((error) => console.error("Error sending verify-target guild error:", error));
      return;
    }

    const targets = ethosTargetUsers.slice(0, 5);
    handleMentionVerifyTargets(message.channel_id, message.id, guildId, targets).catch((error) => {
      console.error("Unexpected error in handleMentionVerifyTargets:", error);
    });
    return;
  }

  if (ethosTargetUsers.length > 0) {
    const cappedTargets = ethosTargetUsers.slice(0, 10); // Discord 10-embed limit
    handleMentionEthos(message.channel_id, message.id, cappedTargets).catch((error) => {
      console.error("Unexpected error in handleMentionEthos:", error);
    });
    return;
  }

  // Check for "recalc" trigger
  if (question.toLowerCase() === "recalc") {
    const guildId = message.guild_id;
    if (!guildId) {
      sendGatewayChannelMessage(
        message.channel_id,
        "This command can only be used in a server.",
        message.id,
      ).catch((error) => console.error("Error sending recalc guild error:", error));
      return;
    }

    const RECALC_ALLOWED_USER = "271050816222265364";
    if (message.author.id !== RECALC_ALLOWED_USER) {
      sendGatewayChannelMessage(
        message.channel_id,
        "You don't have permission to use this command.",
        message.id,
      ).catch((error) => console.error("Error sending recalc permission denied:", error));
      return;
    }

    handleMentionRecalc(message.channel_id, message.id, guildId, message.author.id).catch((error) => {
      console.error("Unexpected error in handleMentionRecalc:", error);
    });
    return;
  }

  // Check for "verify" trigger
  if (question.toLowerCase() === "verify") {
    const guildId = message.guild_id;
    if (!guildId) {
      sendGatewayChannelMessage(
        message.channel_id,
        "This command can only be used in a server.",
        message.id,
      ).catch((error) => console.error("Error sending verify guild error:", error));
      return;
    }

    handleMentionVerify(message.channel_id, message.id, guildId, message.author.id).catch((error) => {
      console.error("Unexpected error in handleMentionVerify:", error);
    });
    return;
  }

  if (!question) {
    sendGatewayChannelMessage(
      message.channel_id,
      "👋 Hi! Ask me anything about Ethos Network — just @mention me with your question.\n\nExample: `@EthosBot how do I verify my account?`",
      message.id,
    ).catch((error) => console.error("Error sending mention hint:", error));
    return;
  }

  if (!ANTHROPIC_API_KEY || !INTERCOM_ACCESS_TOKEN) {
    sendGatewayChannelMessage(
      message.channel_id,
      "The AI help center is not configured yet. Please contact an admin.",
      message.id,
    ).catch((error) => console.error("Error sending config warning:", error));
    return;
  }

  // If replying to another message, include that message's content as context
  let fullQuestion = question;
  if (message.referenced_message?.content) {
    const replyAuthor = message.referenced_message.author?.username || "someone";
    fullQuestion = `[Replying to ${replyAuthor}'s message: "${message.referenced_message.content}"]\n\nMy question: ${question}`;
    console.log(`📩 Including replied-to message from ${replyAuthor}`);
  }

  // Process the question asynchronously (errors are handled inside handleMentionQuestion)
  handleMentionQuestion(message.channel_id, message.id, fullQuestion).catch((error) => {
    console.error("Unexpected error in handleMentionQuestion:", error);
  });
}

async function handleMentionQuestion(channelId: string, messageId: string, question: string): Promise<void> {
  // Send immediate placeholder reply
  const placeholderId = await sendGatewayChannelMessage(
    channelId,
    "\u{1F50D} Looking into that...",
    messageId,
  );

  try {
    const articles = await loadArticlesCache();

    if (articles.length === 0) {
      if (placeholderId) {
        await editGatewayChannelMessage(channelId, placeholderId, {
          content: "No help center articles are available right now. Please try again later.",
        });
      } else {
        await sendGatewayChannelMessage(
          channelId,
          "No help center articles are available right now. Please try again later.",
          messageId,
        );
      }
      return;
    }

    const answer = await askClaude(question, articles);

    if (placeholderId) {
      await editGatewayChannelMessage(channelId, placeholderId, {
        content: "",
        embeds: [{
          title: "Ethos Help Center",
          description: answer,
          color: 0x2E7BC3, // Ethos blue
          footer: {
            text: "AI-generated answer — may not be 100% accurate",
          },
          timestamp: new Date().toISOString(),
        }],
      });
    } else {
      await sendGatewayChannelEmbed(channelId, messageId, {
        title: "Ethos Help Center",
        description: answer,
        color: 0x2E7BC3, // Ethos blue
        footer: {
          text: "AI-generated answer — may not be 100% accurate",
        },
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error) {
    console.error("Error handling mention question:", error);
    const errorMsg = "\u274C Sorry, I ran into an error while answering your question. Please try again later.";
    if (placeholderId) {
      await editGatewayChannelMessage(channelId, placeholderId, { content: errorMsg });
    } else {
      await sendGatewayChannelMessage(channelId, errorMsg, messageId);
    }
  }
}

async function handleMentionRecalc(channelId: string, messageId: string, guildId: string, userId: string): Promise<void> {
  const placeholderId = await sendGatewayChannelMessage(
    channelId,
    "⏳ Recalculating roles...",
    messageId,
  );

  try {
    console.log(`[RECALC] Starting recalculation triggered by user ${userId}`);

    const highScoreMembers = await getMembersWithHighScoreRoles(guildId);

    if (highScoreMembers.length === 0) {
      const msg = "No members found with roles for scores 1400+.";
      if (placeholderId) {
        await editGatewayChannelMessage(channelId, placeholderId, { content: msg });
      } else {
        await sendGatewayChannelMessage(channelId, msg, messageId);
      }
      return;
    }

    if (placeholderId) {
      await editGatewayChannelMessage(channelId, placeholderId, {
        content: `⏳ Found ${highScoreMembers.length} members with high score roles. Recalculating...`,
      });
    }

    let processedCount = 0;
    let changedCount = 0;
    let errorCount = 0;
    const changes: string[] = [];

    for (const memberId of highScoreMembers) {
      try {
        await clearUserCache(memberId);
        const result = await syncUserRoles(guildId, memberId, processedCount + 1, highScoreMembers.length, true, false);
        processedCount++;

        if (result.success && result.changes.length > 0) {
          changedCount++;
          changes.push(`<@${memberId}>: ${result.changes.join(", ")}`);
          await sendRoleChangeWebhook(memberId, result.changes, "recalc-command", {
            guildId: guildId,
            triggeredBy: userId,
          });
        }
      } catch (error) {
        console.error(`[RECALC] Error processing member ${memberId}:`, error);
        errorCount++;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    let summary = `**Recalculation Complete**\n`;
    summary += `- Processed: ${processedCount}/${highScoreMembers.length} members\n`;
    summary += `- Role changes: ${changedCount}\n`;
    summary += `- Errors: ${errorCount}\n`;

    if (changes.length > 0) {
      summary += `\n**Changes made:**\n`;
      const displayChanges = changes.slice(0, 10);
      summary += displayChanges.join("\n");
      if (changes.length > 10) {
        summary += `\n... and ${changes.length - 10} more changes`;
      }
    } else {
      summary += `\nNo role changes were needed - all roles are correct.`;
    }

    if (placeholderId) {
      await editGatewayChannelMessage(channelId, placeholderId, { content: summary });
    } else {
      await sendGatewayChannelMessage(channelId, summary, messageId);
    }
    console.log(`[RECALC] Completed. Processed: ${processedCount}, Changed: ${changedCount}, Errors: ${errorCount}`);
  } catch (error) {
    console.error("[RECALC] Error in recalculation:", error);
    const errorMsg = "❌ An error occurred during recalculation. Please try again later.";
    if (placeholderId) {
      await editGatewayChannelMessage(channelId, placeholderId, { content: errorMsg });
    } else {
      await sendGatewayChannelMessage(channelId, errorMsg, messageId);
    }
  }
}

async function handleMentionVerify(channelId: string, messageId: string, guildId: string, userId: string): Promise<void> {
  const placeholderId = await sendGatewayChannelMessage(
    channelId,
    "🔍 Verifying your Ethos profile...",
    messageId,
  );

  try {
    // Clear cache for manual verification to ensure fresh check
    await clearUserCache(userId);

    // Use the optimized verification logic (always forces sync, bypasses cache)
    const verifyResult = await verifyUserRoles(guildId, userId);

    let resultContent: string;

    if (!verifyResult.success) {
      // Check if it's a profile validation error
      if (verifyResult.profile && "error" in verifyResult.profile) {
        resultContent = verifyResult.profile.error;
      } else {
        resultContent =
          "You don't have an Ethos profile OR you haven't connected Discord to your Ethos account yet. Ethos users can connect their Discord account at https://app.ethos.network/profile/settings?tab=social";
      }
    } else if (verifyResult.profile && "error" in verifyResult.profile) {
      // Profile fetch returned an error (no profile or Discord not connected)
      resultContent = verifyResult.profile.error + "\n\nEthos users can connect their Discord account at https://app.ethos.network/profile/settings?tab=social";
    } else if (!verifyResult.profile) {
      // No profile returned at all
      resultContent =
        "You don't have an Ethos profile OR you haven't connected Discord to your Ethos account yet. Ethos users can connect their Discord account at https://app.ethos.network/profile/settings?tab=social";
    } else {
      const profile = verifyResult.profile;
      const { hasValidator: ownsValidator, isHumanVerified } = await getUserVerificationStatus(userId);
      const scoreName = getRoleNameForScore(profile.score);

      // Send webhook notification for successful role changes
      if (verifyResult.changes.length > 0) {
        const statusParts = [];
        if (ownsValidator) statusParts.push("Validator");
        if (isHumanVerified) statusParts.push("Human Verified");
        if (statusParts.length === 0) statusParts.push("No special status");
        await sendRoleChangeWebhook(userId, verifyResult.changes, "user-initiated", {
          userScore: profile.score,
          profileInfo: `${profile.name || `Discord User ${userId}`} - ${statusParts.join(" + ")}`,
          guildId: guildId,
        });
      }

      // Create response message based on changes made
      resultContent = "✅ Verification successful! ";

      if (verifyResult.changes.length > 0) {
        resultContent += `Role changes: ${verifyResult.changes.join(", ")}. `;
      } else {
        resultContent += "Your roles were already up to date. ";
      }

      // Show the appropriate role information
      {
        const tier = getTierForScore(profile.score);
        let variant: string;
        if (tier.name === "Untrusted") {
          variant = "base";
        } else if (ownsValidator && isHumanVerified) {
          variant = "human_validator";
        } else if (isHumanVerified) {
          variant = "human";
        } else if (ownsValidator) {
          variant = "validator";
        } else {
          variant = "base";
        }
        const roleId = getRoleIdForScore(profile.score, variant);
        const roleName = roleId ? getRoleNameFromId(roleId) : scoreName;
        resultContent += `You have a ${scoreName} score of ${profile.score} and the ${roleName} role.`;
        if (tier.name === "Untrusted" && (ownsValidator || isHumanVerified)) {
          resultContent += " Note: Untrusted users receive the base Untrusted role regardless of other status.";
        }
      }
    }

    if (placeholderId) {
      await editGatewayChannelMessage(channelId, placeholderId, { content: resultContent });
    } else {
      await sendGatewayChannelMessage(channelId, resultContent, messageId);
    }
  } catch (error) {
    console.error("Error in handleMentionVerify:", error);
    const errorMsg = "❌ An error occurred while verifying your profile. Please try again later.";
    if (placeholderId) {
      await editGatewayChannelMessage(channelId, placeholderId, { content: errorMsg });
    } else {
      await sendGatewayChannelMessage(channelId, errorMsg, messageId);
    }
  }
}

async function handleMentionVerifyTargets(
  channelId: string,
  messageId: string,
  guildId: string,
  targets: Array<{ id: string; username: string; global_name?: string }>,
): Promise<void> {
  const plural = targets.length > 1;
  const placeholderId = await sendGatewayChannelMessage(
    channelId,
    `🔍 Verifying ${plural ? `${targets.length} users` : `<@${targets[0].id}>`}...`,
    messageId,
  );

  try {
    if (roleInitPromise) await roleInitPromise;

    const results: string[] = [];

    for (const target of targets) {
      await clearUserCache(target.id);
      const verifyResult = await verifyUserRoles(guildId, target.id);
      const displayName = target.global_name || target.username;

      if (!verifyResult.success || !verifyResult.profile || "error" in verifyResult.profile) {
        results.push(`**${displayName}**: No Ethos profile found`);
        continue;
      }

      const profile = verifyResult.profile;
      const scoreName = getRoleNameForScore(profile.score);

      if (verifyResult.changes.length > 0) {
        results.push(`**${displayName}**: ${verifyResult.changes.join(", ")} (${scoreName} — ${profile.score})`);
      } else {
        results.push(`**${displayName}**: Already up to date (${scoreName} — ${profile.score})`);
      }
    }

    const resultContent = `✅ Verification complete:\n${results.join("\n")}`;

    if (placeholderId) {
      await editGatewayChannelMessage(channelId, placeholderId, { content: resultContent });
    } else {
      await sendGatewayChannelMessage(channelId, resultContent, messageId);
    }
  } catch (error) {
    console.error("Error in handleMentionVerifyTargets:", error);
    const errorMsg = "❌ An error occurred while verifying. Please try again later.";
    if (placeholderId) {
      await editGatewayChannelMessage(channelId, placeholderId, { content: errorMsg });
    } else {
      await sendGatewayChannelMessage(channelId, errorMsg, messageId);
    }
  }
}

async function handleMentionEthos(
  channelId: string,
  messageId: string,
  targetUsers: Array<{ id: string; username: string; global_name?: string; avatar?: string }>,
): Promise<void> {
  const plural = targetUsers.length > 1 ? "s" : "";
  const placeholderId = await sendGatewayChannelMessage(
    channelId,
    `🔍 Looking up Ethos profile${plural}...`,
    messageId,
  );

  try {
    const results = await Promise.all(
      targetUsers.map(async (user) => {
        try {
          const avatarUrl = user.avatar
            ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
            : undefined;
          const profile = await fetchEthosProfileByDiscord(user.id, avatarUrl);
          const displayName = user.global_name || user.username;
          return { user, displayName, avatarUrl, profile, error: null };
        } catch (error) {
          const displayName = user.global_name || user.username;
          return { user, displayName, avatarUrl: undefined, profile: null, error };
        }
      }),
    );

    const embeds: any[] = [];
    const errors: string[] = [];

    for (const result of results) {
      if (result.error || !result.profile) {
        errors.push(`Could not fetch profile for ${result.displayName}.`);
        continue;
      }

      if ("error" in result.profile) {
        errors.push(`${result.displayName}: ${result.profile.error}`);
        continue;
      }

      const profile = result.profile;

      let profileUrl;
      if (profile.primaryAddress) {
        profileUrl = `https://app.ethos.network/profile/${profile.primaryAddress}?src=discord-agent`;
      } else {
        profileUrl = `https://app.ethos.network/profile/discord/${profile.userId}?src=discord-agent`;
      }

      embeds.push({
        title: `Ethos profile for ${result.displayName}`,
        url: profileUrl,
        description: `${result.displayName} is considered **${getScoreLabel(profile.score)}**.${getStatusBadges(profile)}`,
        color: getScoreColor(profile.score),
        thumbnail: {
          url: result.avatarUrl || profile.avatar || "https://cdn.discordapp.com/embed/avatars/0.png",
        },
        fields: [
          {
            name: "Ethos score",
            value: String(profile.score ?? "N/A"),
            inline: true,
          },
          {
            name: "Reviews",
            value: `${profile.elements?.totalReviews} (${profile.elements?.positivePercentage?.toFixed(2)}% positive)`,
            inline: true,
          },
          {
            name: "Vouched",
            value: `${profile.elements?.vouchBalance}e (${profile.elements?.vouchCount} vouchers)`,
            inline: true,
          },
          ...(profile.influenceFactor != null
            ? [{
              name: "Influence factor",
              value: String(profile.influenceFactor),
              inline: true,
            }]
            : []),
          ...(profile.xpTotal != null
            ? [{
              name: "Contributor XP",
              value: Number(profile.xpTotal).toLocaleString(),
              inline: true,
            }]
            : []),
          ...(profile.topReview
            ? [{
              name: "Most upvoted review",
              value: `*"${profile.topReview.comment}"* - ${profile.topReview.authorName} (${profile.topReview.upvotes} upvotes)`,
              inline: false,
            }]
            : []),
        ],
        footer: {
          text: "Data from https://app.ethos.network",
        },
        timestamp: new Date().toISOString(),
      });
    }

    const editOptions: { content?: string; embeds?: any[] } = {};

    if (embeds.length > 0) {
      editOptions.embeds = embeds;
      editOptions.content = errors.length > 0 ? errors.join("\n") : "";
    } else {
      editOptions.content = errors.join("\n") || "❌ Could not fetch any profiles.";
    }

    if (placeholderId) {
      await editGatewayChannelMessage(channelId, placeholderId, editOptions);
    } else {
      await sendGatewayChannelMessage(channelId, editOptions.content || "❌ Could not fetch any profiles.", messageId);
    }
  } catch (error) {
    console.error("Error in handleMentionEthos:", error);
    const errorMsg = "❌ An error occurred while fetching profiles. Please try again later.";
    if (placeholderId) {
      await editGatewayChannelMessage(channelId, placeholderId, { content: errorMsg });
    } else {
      await sendGatewayChannelMessage(channelId, errorMsg, messageId);
    }
  }
}

// ===== GATEWAY CHANNEL MESSAGE SENDERS =====

async function sendGatewayChannelMessage(
  channelId: string,
  content: string,
  replyToMessageId?: string,
): Promise<string | null> {
  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
  const body: any = { content };
  if (replyToMessageId) {
    body.message_reference = { message_id: replyToMessageId };
    body.allowed_mentions = { replied_user: false };
  }
  const response = await discordApiCall(url, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    console.error(`Failed to send channel message: ${response.status} ${text}`);
    return null;
  }
  const data = await response.json();
  return data.id ?? null;
}

async function editGatewayChannelMessage(
  channelId: string,
  messageId: string,
  options: { content?: string; embeds?: any[] },
): Promise<void> {
  const url = `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`;
  const response = await discordApiCall(url, {
    method: "PATCH",
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const text = await response.text();
    console.error(`Failed to edit channel message: ${response.status} ${text}`);
  }
}

async function isGuildAdmin(guildId: string, memberRoles: string[]): Promise<boolean> {
  const url = `https://discord.com/api/v10/guilds/${guildId}/roles`;
  const response = await discordApiCall(url, { method: "GET" });
  if (!response.ok) {
    console.error(`Failed to fetch guild roles: ${response.status}`);
    return false;
  }
  const roles: any[] = await response.json();
  for (const role of roles) {
    if (memberRoles.includes(role.id) && (BigInt(role.permissions) & BigInt(0x8)) !== BigInt(0)) {
      return true;
    }
  }
  return false;
}

async function sendGatewayChannelEmbed(
  channelId: string,
  replyToMessageId: string,
  embed: any,
): Promise<void> {
  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
  const response = await discordApiCall(url, {
    method: "POST",
    body: JSON.stringify({
      embeds: [embed],
      message_reference: { message_id: replyToMessageId },
      allowed_mentions: { replied_user: false },
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    console.error(`Failed to send channel embed: ${response.status} ${text}`);
  }
}

// Start HTTP server
serve(async (req) => {
  const url = new URL(req.url);

  // Handle role sync trigger endpoint
  if (url.pathname === "/trigger-sync" && req.method === "POST") {
    try {
      // Optional: Add authentication here
      const authHeader = req.headers.get("Authorization");
      const expectedAuth = Deno.env.get("SYNC_AUTH_TOKEN");

      if (expectedAuth && authHeader !== `Bearer ${expectedAuth}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      // Get guild ID and optional parameters from request body
      let guildId: string | undefined;
      let startIndex = 0;
      let chunkSize = SYNC_CONFIG.CHUNK_SIZE;

      try {
        const body = await req.json();
        guildId = body.guildId;
        startIndex = body.startIndex || 0;
        chunkSize = body.chunkSize || SYNC_CONFIG.CHUNK_SIZE;
      } catch {
        // No body or invalid JSON, use defaults
      }

      // Trigger the chunked sync asynchronously
      triggerChunkedRoleSync(guildId, startIndex, chunkSize, "[HTTP] ").catch(
        (error) => {
          console.error("[HTTP] Error in triggered chunked sync:", error);
        },
      );

      return new Response(
        JSON.stringify({
          success: true,
          message: "Chunked role synchronization triggered",
          guildId: guildId || Deno.env.get("DISCORD_GUILD_ID") || "default",
          startIndex,
          chunkSize,
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    } catch (error) {
      console.error("Error triggering sync:", error);
      return new Response(
        JSON.stringify({
          success: false,
          error: "Failed to trigger sync",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }

  // Handle sync stop endpoint
  if (url.pathname === "/stop-sync" && req.method === "POST") {
    try {
      // Optional: Add authentication here
      const authHeader = req.headers.get("Authorization");
      const expectedAuth = Deno.env.get("SYNC_AUTH_TOKEN");

      if (expectedAuth && authHeader !== `Bearer ${expectedAuth}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      const stopped = stopSync();

      return new Response(
        JSON.stringify({
          success: true,
          message: stopped
            ? "Stop signal sent to running sync"
            : "No sync currently running",
          wasStopped: stopped,
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    } catch (error) {
      console.error("Error stopping sync:", error);
      return new Response(
        JSON.stringify({
          success: false,
          error: "Failed to stop sync",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }

  // Handle batch sync trigger endpoint (new optimized version)
  if (url.pathname === "/trigger-batch-sync" && req.method === "POST") {
    try {
      // Optional: Add authentication here
      const authHeader = req.headers.get("Authorization");
      const expectedAuth = Deno.env.get("SYNC_AUTH_TOKEN");

      if (expectedAuth && authHeader !== `Bearer ${expectedAuth}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      // Get guild ID from request body
      let guildId: string | undefined;
      try {
        const body = await req.json();
        guildId = body.guildId;
      } catch {
        // No body or invalid JSON, use default
      }

      const targetGuildId = guildId || Deno.env.get("DISCORD_GUILD_ID");
      if (!targetGuildId) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "guildId is required (either in request or DISCORD_GUILD_ID env var)",
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // Trigger the batch sync asynchronously
      (async () => {
        try {
          console.log("[HTTP] Starting batch sync");
          
          // Get all verified members
          const verifiedMembers = await getVerifiedMembers(targetGuildId);
          console.log(`[HTTP] Found ${verifiedMembers.length} verified members`);
          
          if (verifiedMembers.length === 0) {
            console.log("[HTTP] No verified members found");
            return;
          }

          // Use batch sync function
          const result = await syncUserRolesBatch(targetGuildId, verifiedMembers, false);
          
          console.log(`[HTTP] Batch sync completed. Changes: ${result.changes.size}, Errors: ${result.errors.length}`);
          
          // Log summary
          let totalChanges = 0;
          for (const [userId, userChanges] of result.changes) {
            totalChanges += userChanges.length;
            console.log(`[HTTP] User ${userId}: ${userChanges.join(", ")}`);
          }
          
          if (result.errors.length > 0) {
            console.log(`[HTTP] Errors: ${result.errors.join("; ")}`);
          }
          
          console.log(`[HTTP] === Batch sync complete: ${result.changes.size} users changed, ${totalChanges} total changes ===`);
          
        } catch (error) {
          console.error("[HTTP] Error in batch sync:", error);
        }
      })().catch(error => {
        console.error("[HTTP] Error in async batch sync:", error);
      });

      return new Response(
        JSON.stringify({
          success: true,
          message: "Batch role synchronization triggered (optimized with batch APIs)",
          guildId: targetGuildId,
          note: "This uses the new batch APIs and should be much faster than individual sync"
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    } catch (error) {
      console.error("Error triggering batch sync:", error);
      return new Response(
        JSON.stringify({
          success: false,
          error: "Failed to trigger batch sync",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }

  // Handle sync status endpoint
  if (url.pathname === "/sync-status" && req.method === "GET") {
    try {
      const status = getSyncStatus();
      const cacheStats = await getCacheStats();
      const rateLimitStatus = getRateLimitStatus();

      return new Response(
        JSON.stringify({
          success: true,
          status,
          cache: {
            totalEntries: cacheStats.totalCached,
            cacheDurationDays: CACHE_DURATION_MS / (24 * 60 * 60 * 1000),
          },
          rateLimits: rateLimitStatus,
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    } catch (error) {
      console.error("Error getting sync status:", error);
      return new Response(
        JSON.stringify({
          success: false,
          error: "Failed to get sync status",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }

  // Handle rate limit reset endpoint
  if (url.pathname === "/reset-rate-limits" && req.method === "POST") {
    try {
      // Optional: Add authentication here
      const authHeader = req.headers.get("Authorization");
      const expectedAuth = Deno.env.get("SYNC_AUTH_TOKEN");

      if (expectedAuth && authHeader !== `Bearer ${expectedAuth}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      resetRateLimitState();

      return new Response(
        JSON.stringify({
          success: true,
          message: "Rate limit state reset successfully",
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    } catch (error) {
      console.error("Error resetting rate limits:", error);
      return new Response(
        JSON.stringify({
          success: false,
          error: "Failed to reset rate limits",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }

  // Handle force sync endpoint for specific users
  if (url.pathname === "/force-sync" && req.method === "POST") {
    try {
      // Optional: Add authentication here
      const authHeader = req.headers.get("Authorization");
      const expectedAuth = Deno.env.get("SYNC_AUTH_TOKEN");

      if (expectedAuth && authHeader !== `Bearer ${expectedAuth}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      // Get parameters from request body
      let guildId: string | undefined;
      let userId: string | undefined;

      try {
        const body = await req.json();
        guildId = body.guildId;
        userId = body.userId;
      } catch {
        return new Response(
          JSON.stringify({
            success: false,
            error:
              "Invalid request body. Expected JSON with guildId and userId",
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (!userId) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "userId is required",
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      const targetGuildId = guildId || Deno.env.get("DISCORD_GUILD_ID");
      if (!targetGuildId) {
        return new Response(
          JSON.stringify({
            success: false,
            error:
              "guildId is required (either in request or DISCORD_GUILD_ID env var)",
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // Clear cache for this user first
      await clearUserCache(userId);

      // Force sync the user (bypass cache)
      const result = await syncIndividualUser(targetGuildId, userId, true);

      return new Response(
        JSON.stringify({
          success: result.success,
          userId,
          guildId: targetGuildId,
          changes: result.changes,
          message: result.success
            ? (result.changes.length > 0
              ? `Applied ${result.changes.length} role changes`
              : "No changes needed")
            : "Force sync failed",
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    } catch (error) {
      console.error("Error in force sync:", error);
      return new Response(
        JSON.stringify({
          success: false,
          error: "Failed to force sync user",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }

  // Handle cache stats endpoint
  if (url.pathname === "/cache-stats" && req.method === "GET") {
    try {
      // Optional: Add authentication here
      const authHeader = req.headers.get("Authorization");
      const expectedAuth = Deno.env.get("SYNC_AUTH_TOKEN");

      if (expectedAuth && authHeader !== `Bearer ${expectedAuth}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      const cacheStats = await getCacheStats();

      return new Response(
        JSON.stringify({
          success: true,
          cache: {
            totalEntries: cacheStats.totalCached,
            cacheDurationMs: CACHE_DURATION_MS,
            cacheDurationDays: CACHE_DURATION_MS / (24 * 60 * 60 * 1000),
            oldestEntry: cacheStats.oldestEntry,
            newestEntry: cacheStats.newestEntry,
            oldestEntryDate: cacheStats.oldestEntry
              ? new Date(cacheStats.oldestEntry).toISOString()
              : null,
            newestEntryDate: cacheStats.newestEntry
              ? new Date(cacheStats.newestEntry).toISOString()
              : null,
          },
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    } catch (error) {
      console.error("Error getting cache stats:", error);
      return new Response(
        JSON.stringify({
          success: false,
          error: "Failed to get cache stats",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }

  // Handle validator verification trigger endpoint
  if (url.pathname === "/trigger-validator-check" && req.method === "POST") {
    try {
      // Optional: Add authentication here
      const authHeader = req.headers.get("Authorization");
      const expectedAuth = Deno.env.get("SYNC_AUTH_TOKEN");

      if (expectedAuth && authHeader !== `Bearer ${expectedAuth}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      // Get guild ID from request body
      let guildId: string | undefined;

      try {
        const body = await req.json();
        guildId = body.guildId;
      } catch {
        // No body or invalid JSON, use default
      }

      // Trigger the validator verification asynchronously
      triggerValidatorVerification(guildId).catch((error) => {
        console.error("[HTTP] Error in triggered validator verification:", error);
      });

      return new Response(
        JSON.stringify({
          success: true,
          message: "Validator verification triggered",
          guildId: guildId || Deno.env.get("DISCORD_GUILD_ID") || "default",
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    } catch (error) {
      console.error("Error triggering validator verification:", error);
      return new Response(
        JSON.stringify({
          success: false,
          error: "Failed to trigger validator verification",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }

  // Handle validator verification stop endpoint
  if (url.pathname === "/stop-validator-check" && req.method === "POST") {
    try {
      // Optional: Add authentication here
      const authHeader = req.headers.get("Authorization");
      const expectedAuth = Deno.env.get("SYNC_AUTH_TOKEN");

      if (expectedAuth && authHeader !== `Bearer ${expectedAuth}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      const stopped = stopValidatorCheck();

      return new Response(
        JSON.stringify({
          success: true,
          message: stopped
            ? "Stop signal sent to running validator verification"
            : "No validator verification currently running",
          wasStopped: stopped,
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    } catch (error) {
      console.error("Error stopping validator verification:", error);
      return new Response(
        JSON.stringify({
          success: false,
          error: "Failed to stop validator verification",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }

  // Handle role initialization endpoint
  if (url.pathname === "/initialize-roles" && req.method === "POST") {
    try {
      const authHeader = req.headers.get("Authorization");
      const expectedAuth = Deno.env.get("SYNC_AUTH_TOKEN");

      if (expectedAuth && authHeader !== `Bearer ${expectedAuth}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      let guildId: string | undefined;
      try {
        const body = await req.json();
        guildId = body.guildId;
      } catch {
        // No body or invalid JSON, use default
      }

      const targetGuildId = guildId || Deno.env.get("DISCORD_GUILD_ID");
      if (!targetGuildId) {
        return new Response(
          JSON.stringify({ success: false, error: "guildId is required" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      // Run initialization
      roleInitPromise = initializeRoles(targetGuildId);
      await roleInitPromise;

      return new Response(
        JSON.stringify({
          success: true,
          message: "Role initialization complete",
          rolesRegistered: roleRegistry.size,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    } catch (error) {
      console.error("Error in /initialize-roles:", error);
      return new Response(
        JSON.stringify({ success: false, error: "Failed to initialize roles" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  // Handle validator verification status endpoint
  if (url.pathname === "/validator-check-status" && req.method === "GET") {
    try {
      const status = getValidatorCheckStatus();

      return new Response(
        JSON.stringify({
          success: true,
          status,
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    } catch (error) {
      console.error("Error getting validator check status:", error);
      return new Response(
        JSON.stringify({
          success: false,
          error: "Failed to get validator check status",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }

  // Refresh help center articles cache
  if (url.pathname === "/refresh-articles" && req.method === "POST") {
    try {
      const authHeader = req.headers.get("Authorization");
      const expectedAuth = Deno.env.get("SYNC_AUTH_TOKEN");

      if (expectedAuth && authHeader !== `Bearer ${expectedAuth}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      if (!INTERCOM_ACCESS_TOKEN) {
        return new Response(
          JSON.stringify({ success: false, error: "INTERCOM_ACCESS_TOKEN not configured" }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }

      const articles = await refreshArticlesCache();

      return new Response(
        JSON.stringify({
          success: true,
          message: `Refreshed ${articles.length} articles from Intercom`,
          articleCount: articles.length,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    } catch (error) {
      console.error("Error refreshing articles:", error);
      return new Response(
        JSON.stringify({ success: false, error: "Failed to refresh articles" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  // Health check endpoint
  if (url.pathname === "/health" && req.method === "GET") {
    return new Response(
      JSON.stringify({
        status: "healthy",
        timestamp: new Date().toISOString(),
      }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // Handle Discord interactions
  if (req.method === "POST" && url.pathname === "/") {
    try {
      const interaction = await verifyRequest(req);
      if (!interaction) {
        return new Response("Invalid request signature", { status: 401 });
      }

      const response = await handleInteraction(interaction);
      return new Response(JSON.stringify(response), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("Error handling request:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  return new Response("OK", { status: 200 });
});

// Start Discord Gateway WebSocket (runs concurrently with HTTP server).
// Deferred via setTimeout to ensure all module-level constants (e.g. SYNC_CONFIG) are initialized.
setTimeout(() => {
  connectGateway().catch((error) => {
    console.error("Failed to start Gateway WebSocket:", error);
  });
}, 0);

// ===== AUTOMATED ROLE SYNCHRONIZATION =====

// Global sync state management - only for bulk operations
let bulkSyncStatus = {
  isRunning: false,
  shouldStop: false,
  currentGuild: null as string | null,
  startTime: null as number | null,
  processedUsers: 0,
  totalUsers: 0,
  currentBatch: 0,
  lastProcessedIndex: 0,
  syncId: null as string | null, // Unique ID for each sync session
};

// Configuration for chunked processing
const SYNC_CONFIG = {
  // Conservative settings (current)
  CONSERVATIVE: {
    BATCH_SIZE: 5,
    DELAY_BETWEEN_USERS: 5000,
    DELAY_BETWEEN_BATCHES: 15000,
    DELAY_BETWEEN_ROLE_OPS: 1500,
  },
  
  // Smart aggressive settings (new)
  AGGRESSIVE: {
    BATCH_SIZE: 12,                    // Larger batches
    DELAY_BETWEEN_USERS: 800,          // Much faster (0.8s)
    DELAY_BETWEEN_BATCHES: 3000,       // Faster batches (3s)
    DELAY_BETWEEN_ROLE_OPS: 300,       // Faster role ops (0.3s)
    PARALLEL_OPERATIONS: 3,            // Process multiple users in parallel
    RATE_LIMIT_SAFETY_THRESHOLD: 8,    // Slow down when < 8 requests remaining
    ADAPTIVE_BACKOFF_MULTIPLIER: 2.0,  // More aggressive backoff
  },
  
  // Current active config - start conservative, can switch to aggressive
  get ACTIVE() {
    const mode = Deno.env.get("SYNC_MODE") || "conservative";
    return mode === "aggressive" ? this.AGGRESSIVE : this.CONSERVATIVE;
  },
  
  // Legacy properties for backward compatibility
  get BATCH_SIZE() { return this.ACTIVE.BATCH_SIZE; },
  get CHUNK_SIZE() { return 25; }, // Keep existing chunk size
  get MAX_EXECUTION_TIME() { return 12 * 60 * 1000; }, // 12 minutes max execution
  get DELAY_BETWEEN_USERS() { return this.ACTIVE.DELAY_BETWEEN_USERS; },
  get DELAY_BETWEEN_BATCHES() { return this.ACTIVE.DELAY_BETWEEN_BATCHES; },
  get DELAY_BETWEEN_ROLE_OPS() { return this.ACTIVE.DELAY_BETWEEN_ROLE_OPS; },
  get INDIVIDUAL_USER_DELAY() { return 500; }, // Increased from 100ms to 500ms
  // New adaptive rate limiting settings
  get ADAPTIVE_DELAY_MULTIPLIER() { return 1.5; }, // Multiply delays when rate limited
  get MAX_ADAPTIVE_DELAY() { return 30000; }, // Max 30 seconds adaptive delay
  get RATE_LIMIT_COOLDOWN() { return 60000; }, // 1 minute cooldown after hitting rate limits
};

// Function to stop the current bulk sync
export function stopSync(): boolean {
  if (bulkSyncStatus.isRunning) {
    console.log("Stop signal sent to running bulk sync process");
    bulkSyncStatus.shouldStop = true;
    return true;
  }
  return false;
}

// Function to get sync status
export function getSyncStatus() {
  return {
    ...bulkSyncStatus,
    duration: bulkSyncStatus.startTime
      ? Date.now() - bulkSyncStatus.startTime
      : 0,
  };
}

// Function to reset sync status
function resetBulkSyncStatus() {
  bulkSyncStatus = {
    isRunning: false,
    shouldStop: false,
    currentGuild: null,
    startTime: null,
    processedUsers: 0,
    totalUsers: 0,
    currentBatch: 0,
    lastProcessedIndex: 0,
    syncId: null,
  };
}

// Function to generate unique sync ID
function generateSyncId(): string {
  return `sync_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

// Function to get all verified members from a guild
async function getVerifiedMembers(guildId: string): Promise<string[]> {
  try {
    console.log("Fetching verified members from guild:", guildId);

    // Get all members with the verified role
    const url =
      `https://discord.com/api/v10/guilds/${guildId}/members?limit=1000`;

    const response = await discordApiCall(url, {
      method: "GET",
    });

    if (!response.ok) {
      console.error(`Failed to fetch guild members: ${response.status}`);
      return [];
    }

    const members = await response.json();

    // Filter members who have the verified role
    const verifiedMembers = members
      .filter((member: any) => member.roles.includes(ETHOS_VERIFIED_ROLE_ID))
      .map((member: any) => member.user.id);

    console.log(`Found ${verifiedMembers.length} verified members`);
    return verifiedMembers;
  } catch (error) {
    console.error("Error fetching verified members:", error);
    return [];
  }
}

// Function to get all members with roles for scores >= 1400
async function getMembersWithHighScoreRoles(guildId: string): Promise<string[]> {
  try {
    console.log("[RECALC] Fetching members with high score roles (1400+) from guild:", guildId);

    // All roles that indicate score >= 1400 (all variants)
    const highScoreTiers = SCORE_TIERS.filter(t => t.minScore >= 1400);
    const highScoreRoles: string[] = [];
    for (const tier of highScoreTiers) {
      for (const variantKey of getVariantsForTier(tier.name)) {
        const id = roleRegistry.get(`${tier.name}:${variantKey}`) || LEGACY_ROLE_IDS[`${tier.name}:${variantKey}`];
        if (id) highScoreRoles.push(id);
      }
    }

    const url = `https://discord.com/api/v10/guilds/${guildId}/members?limit=1000`;

    const response = await discordApiCall(url, {
      method: "GET",
    });

    if (!response.ok) {
      console.error(`[RECALC] Failed to fetch guild members: ${response.status}`);
      return [];
    }

    const members = await response.json();

    // Filter members who have any of the high score roles
    const highScoreMembers = members
      .filter((member: any) => member.roles.some((roleId: string) => highScoreRoles.includes(roleId)))
      .map((member: any) => member.user.id);

    console.log(`[RECALC] Found ${highScoreMembers.length} members with high score roles`);
    return highScoreMembers;
  } catch (error) {
    console.error("[RECALC] Error fetching members with high score roles:", error);
    return [];
  }
}

// Function to get current Ethos roles for a user
function getCurrentEthosRoles(userRoles: string[]): string[] {
  const managedIds = getAllManagedRoleIds();
  return userRoles.filter((roleId) => managedIds.includes(roleId));
}

// Function to get expected roles based on Ethos profile
function getExpectedRoles(
  score: number,
  hasValidator: boolean,
  isHumanVerified: boolean,
  hasValidProfile: boolean,
): string[] {
  const expectedRoles = [ETHOS_VERIFIED_ROLE_ID]; // Always has basic verified role

  if (hasValidProfile) {
    expectedRoles.push(ETHOS_VERIFIED_PROFILE_ROLE_ID);
  }

  // Standalone meta roles — for easy @mention
  if (hasValidator && ETHOS_VALIDATOR_META_ROLE_ID) {
    expectedRoles.push(ETHOS_VALIDATOR_META_ROLE_ID);
  }
  if (isHumanVerified && ETHOS_HUMAN_VERIFIED_META_ROLE_ID) {
    expectedRoles.push(ETHOS_HUMAN_VERIFIED_META_ROLE_ID);
  }
  if (hasValidator && isHumanVerified && ETHOS_HUMAN_VALIDATOR_META_ROLE_ID) {
    expectedRoles.push(ETHOS_HUMAN_VALIDATOR_META_ROLE_ID);
  }

  if (hasValidProfile) {
    // Determine the best variant for this user
    let variant: string;
    const tier = getTierForScore(score);

    if (tier.name === "Untrusted") {
      variant = "base"; // Untrusted always gets base
    } else if (hasValidator && isHumanVerified) {
      variant = "human_validator";
    } else if (isHumanVerified) {
      variant = "human";
    } else if (hasValidator) {
      variant = "validator";
    } else {
      variant = "base";
    }

    const roleId = getRoleIdForScore(score, variant);
    if (roleId) {
      expectedRoles.push(roleId);
    } else {
      // Fallback to base if variant role not found
      const baseId = getRoleIdForScore(score, "base");
      if (baseId) expectedRoles.push(baseId);
    }
  }

  return expectedRoles;
}

// Function to verify and sync a user's roles (optimized for verification command)
async function verifyUserRoles(
  guildId: string,
  userId: string,
): Promise<{ success: boolean; changes: string[]; profile?: any }> {
  try {
    console.log(`[VERIFY] Verifying roles for user: ${userId}`);

    // Use the new individual sync function (bypasses bulk sync state)
    const result = await syncIndividualUser(guildId, userId, true);

    return result;
  } catch (error) {
    console.error(`[VERIFY] Error verifying user ${userId}:`, error);
    return { success: false, changes: [] };
  }
}

// Function to sync a single user's roles
async function syncUserRoles(
  guildId: string,
  userId: string,
  userNumber?: number,
  totalUsers?: number,
  forceSync = false,
  isBulkOperation = false,
): Promise<{ success: boolean; changes: string[]; skipped?: boolean }> {
  // Wait for role initialization if pending
  if (roleInitPromise) await roleInitPromise;

  try {
    const progressPrefix = userNumber && totalUsers
      ? `[${userNumber}/${totalUsers}] `
      : "";
    const operationType = isBulkOperation ? "BULK" : "INDIVIDUAL";

    // Check cache first (unless forced)
    if (!forceSync) {
      const recentlySynced = await wasRecentlySynced(userId);
      if (recentlySynced) {
        console.log(
          `${progressPrefix}⏭️ [${operationType}] Skipping user ${userId} (synced within last 3 days)`,
        );
        return { success: true, changes: [], skipped: true };
      }
    }

    console.log(
      `${progressPrefix}[${operationType}] Syncing roles for user: ${userId}`,
    );

    // Get user's current Discord roles
    const memberUrl =
      `https://discord.com/api/v10/guilds/${guildId}/members/${userId}`;
    const memberResponse = await discordApiCall(memberUrl, { method: "GET" });

    if (!memberResponse.ok) {
      console.error(
        `${progressPrefix}[${operationType}] Failed to fetch member ${userId}: ${memberResponse.status}`,
      );
      return { success: false, changes: [] };
    }

    const memberData = await memberResponse.json();
    const currentRoles = memberData.roles || [];
    const currentEthosRoles = getCurrentEthosRoles(currentRoles);

    // Fetch user's Ethos profile
    const profile = await fetchEthosProfileByDiscord(userId);

    if ("error" in profile) {
      console.log(
        `${progressPrefix}[${operationType}] User ${userId} has no valid Ethos profile, removing score-based, validator, and verified profile roles only`,
      );

      // Remove score-based, validator, and verified profile roles, but keep basic verified role
      const rolesToRemove = currentEthosRoles.filter((roleId) =>
        roleId !== ETHOS_VERIFIED_ROLE_ID
      );
      const changes: string[] = [];

      // If this is a forced individual verification (ethos_verify), also remove the special role if present
      if (!isBulkOperation && forceSync) {
        if (currentRoles.includes(ROLE_TO_REMOVE_ON_VERIFY)) {
          const removeSpecialUrl = `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${ROLE_TO_REMOVE_ON_VERIFY}`;
          const removeSpecialResponse = await discordApiCall(removeSpecialUrl, { method: "DELETE" });
          if (removeSpecialResponse.ok) {
            changes.push("Removed special role (default/incomplete profile)");
            console.log(`${progressPrefix}[${operationType}] Removed special role ${ROLE_TO_REMOVE_ON_VERIFY} from user ${userId} (default/incomplete profile)`);
          }
          // Use shorter delay for individual operations
          const delay = isBulkOperation
            ? SYNC_CONFIG.DELAY_BETWEEN_ROLE_OPS
            : SYNC_CONFIG.INDIVIDUAL_USER_DELAY;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }

      // If this is a forced individual verification (ethos_verify), also remove the special role if present
      if (!isBulkOperation && forceSync) {
        if (currentRoles.includes(ROLE_TO_REMOVE_ON_VERIFY)) {
          const removeSpecialUrl = `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${ROLE_TO_REMOVE_ON_VERIFY}`;
          const removeSpecialResponse = await discordApiCall(removeSpecialUrl, { method: "DELETE" });
          if (removeSpecialResponse.ok) {
            changes.push("Removed special role");
            console.log(`${progressPrefix}[${operationType}] Removed special role ${ROLE_TO_REMOVE_ON_VERIFY} from user ${userId}`);
          }
          // Use shorter delay for individual operations
          const delay = isBulkOperation
            ? SYNC_CONFIG.DELAY_BETWEEN_ROLE_OPS
            : SYNC_CONFIG.INDIVIDUAL_USER_DELAY;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }

      for (const roleId of rolesToRemove) {
        const removeUrl =
          `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`;
        const removeResponse = await discordApiCall(removeUrl, {
          method: "DELETE",
        });

        if (removeResponse.ok) {
          const roleName = getRoleNameFromId(roleId);
          changes.push(`Removed ${roleName} role`);
          console.log(`[VERIFY] Removed role ${roleName} from user ${userId}`);
        }

        // Small delay to avoid rate limiting
        await new Promise((resolve) =>
          setTimeout(resolve, SYNC_CONFIG.DELAY_BETWEEN_ROLE_OPS)
        );
      }

      // Mark as synced even if profile is invalid (so we don't keep retrying)
      await markUserSynced(userId);
      return { success: true, changes };
    }

    // Apply the same validation logic as ethos_verify command
    const hasInteractions = (profile.elements?.totalReviews > 0) ||
      (profile.elements?.vouchCount > 0) ||
      profile.primaryAddress;

    // Check for exactly 1200 score with no interactions, which appears to be a default value
    const isDefaultProfile = profile.score === 1200 && !hasInteractions;

    if (
      profile.score === undefined || typeof profile.score !== "number" ||
      !hasInteractions || isDefaultProfile
    ) {
      console.log(
        `${progressPrefix}[${operationType}] User ${userId} has default/empty profile: score=${profile.score}, reviews=${profile.elements?.totalReviews}, vouches=${profile.elements?.vouchCount}, wallet=${
          profile.primaryAddress ? "yes" : "no"
        } - removing score-based, validator, and verified profile roles only`,
      );

      // Remove score-based, validator, and verified profile roles, but keep basic verified role
      const rolesToRemove = currentEthosRoles.filter((roleId) =>
        roleId !== ETHOS_VERIFIED_ROLE_ID
      );
      const changes: string[] = [];

      for (const roleId of rolesToRemove) {
        const removeUrl =
          `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`;
        const removeResponse = await discordApiCall(removeUrl, {
          method: "DELETE",
        });

        if (removeResponse.ok) {
          const roleName = getRoleNameFromId(roleId);
          changes.push(`Removed ${roleName} role (default/incomplete profile)`);
          console.log(
            `${progressPrefix}[${operationType}] Removed role ${roleName} from user ${userId} (default/incomplete profile)`,
          );
        }

        // Use shorter delay for individual operations
        const delay = isBulkOperation
          ? SYNC_CONFIG.DELAY_BETWEEN_ROLE_OPS
          : SYNC_CONFIG.INDIVIDUAL_USER_DELAY;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      // Mark as synced even if profile is incomplete (so we don't keep retrying)
      await markUserSynced(userId);
      return { success: true, changes };
    }

    // User has a valid profile, proceed with normal role sync
    console.log(
      `${progressPrefix}[${operationType}] User ${userId} has valid profile with score ${profile.score} and primaryAddress: ${
        profile.primaryAddress ? "yes" : "no"
      }`,
    );

    // Check validator + human verification status
    const { hasValidator, isHumanVerified } = await getUserVerificationStatus(userId);

    // Get expected roles
    const expectedRoles = getExpectedRoles(profile.score, hasValidator, isHumanVerified, true);

    // Compare current vs expected roles
    const rolesToAdd = expectedRoles.filter((roleId) =>
      !currentRoles.includes(roleId)
    );
    const rolesToRemove = currentEthosRoles.filter((roleId) =>
      !expectedRoles.includes(roleId)
    );

    // If this is a forced individual verification (ethos_verify), also remove the special role if present
    const changes: string[] = [];
    if (!isBulkOperation && forceSync) {
      if (currentRoles.includes(ROLE_TO_REMOVE_ON_VERIFY)) {
        const removeSpecialUrl = `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${ROLE_TO_REMOVE_ON_VERIFY}`;
        const removeSpecialResponse = await discordApiCall(removeSpecialUrl, { method: "DELETE" });
        if (removeSpecialResponse.ok) {
          changes.push("Removed special role");
          console.log(`${progressPrefix}[${operationType}] Removed special role ${ROLE_TO_REMOVE_ON_VERIFY} from user ${userId}`);
        }
        const delay = isBulkOperation ? SYNC_CONFIG.DELAY_BETWEEN_ROLE_OPS : SYNC_CONFIG.INDIVIDUAL_USER_DELAY;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // Early exit if no changes needed
    if (rolesToAdd.length === 0 && rolesToRemove.length === 0 && changes.length === 0) {
      console.log(
        `${progressPrefix}[${operationType}] User ${userId} already has correct roles, no changes needed`,
      );
      // Mark as synced since roles are correct
      await markUserSynced(userId);
      return { success: true, changes: [] };
    }

    // Remove roles that shouldn't be there
    for (const roleId of rolesToRemove) {
      const removeUrl =
        `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`;
      const removeResponse = await discordApiCall(removeUrl, {
        method: "DELETE",
      });

      if (removeResponse.ok) {
        const roleName = getRoleNameFromId(roleId);
        changes.push(`Removed ${roleName} role`);
        console.log(
          `${progressPrefix}[${operationType}] Removed role ${roleName} from user ${userId}`,
        );
      }

      // Use shorter delay for individual operations
      const delay = isBulkOperation
        ? SYNC_CONFIG.DELAY_BETWEEN_ROLE_OPS
        : SYNC_CONFIG.INDIVIDUAL_USER_DELAY;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    // Add roles that should be there
    for (const roleId of rolesToAdd) {
      const addUrl =
        `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`;
      const addResponse = await discordApiCall(addUrl, { method: "PUT" });

      if (addResponse.ok) {
        const roleName = getRoleNameFromId(roleId);
        changes.push(`Added ${roleName} role`);
        console.log(
          `${progressPrefix}[${operationType}] Added role ${roleName} to user ${userId}`,
        );
      }

      // Use shorter delay for individual operations
      const delay = isBulkOperation
        ? SYNC_CONFIG.DELAY_BETWEEN_ROLE_OPS
        : SYNC_CONFIG.INDIVIDUAL_USER_DELAY;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    // Send webhook notification for role changes
    if (changes.length > 0) {
      const context = isBulkOperation ? "batch-sync" : "individual-sync";
      await sendRoleChangeWebhook(userId, changes, context, {
        userScore: profile?.score,
        profileInfo: profile?.hasProfile 
          ? `Profile found - ${profile.elements?.totalReviews || 0} reviews, ${profile.elements?.vouchCount || 0} vouches`
          : "No valid profile",
        guildId: guildId,
        processedCount: userNumber,
        totalCount: totalUsers,
      });
    }

    // Mark as synced after successful role updates
    await markUserSynced(userId);
    return { success: true, changes };
  } catch (error) {
    const progressPrefix = userNumber && totalUsers
      ? `[${userNumber}/${totalUsers}] `
      : "";
    const operationType = isBulkOperation ? "BULK" : "INDIVIDUAL";
    console.error(
      `${progressPrefix}[${operationType}] Error syncing user ${userId}:`,
      error,
    );
    return { success: false, changes: [] };
  }
}

// Optimized individual user sync function (for Discord commands)
async function syncIndividualUser(
  guildId: string,
  userId: string,
  forceSync = false,
): Promise<{ success: boolean; changes: string[]; profile?: any }> {
  try {
    console.log(`[INDIVIDUAL] Fast sync for user: ${userId}`);

    // Don't check bulk sync status - individual operations are independent
    const result = await syncUserRoles(
      guildId,
      userId,
      undefined,
      undefined,
      forceSync,
      false,
    );

    if (!result.success) {
      return { success: false, changes: result.changes };
    }

    // For verification command, we also need to return profile info
    if (forceSync) {
      const profile = await fetchEthosProfileByDiscord(userId);
      return { success: true, changes: result.changes, profile };
    }

    return { success: true, changes: result.changes };
  } catch (error) {
    console.error(
      `[INDIVIDUAL] Error in individual sync for user ${userId}:`,
      error,
    );
    return { success: false, changes: [] };
  }
}

// Manual sync function that can be triggered by command
async function performManualSync(guildId: string): Promise<void> {
  console.log(
    `[MANUAL] === Starting manual role synchronization for guild ${guildId} ===`,
  );
  await performSyncForGuild(guildId);
}

// Core sync logic that can be used by both daily and manual sync
async function performSyncForGuild(guildId: string): Promise<void> {
  // Check if already running
  if (bulkSyncStatus.isRunning) {
    console.log("Sync already in progress, skipping");
    return;
  }

  // Initialize sync status
  bulkSyncStatus.isRunning = true;
  bulkSyncStatus.shouldStop = false;
  bulkSyncStatus.currentGuild = guildId;
  bulkSyncStatus.startTime = Date.now();
  bulkSyncStatus.processedUsers = 0;
  bulkSyncStatus.totalUsers = 0;

  console.log("=== Starting role synchronization ===");
  const startTime = Date.now();

  try {
    // Get all verified members
    const verifiedMembers = await getVerifiedMembers(guildId);

    if (verifiedMembers.length === 0) {
      console.log("No verified members found, sync complete");
      return;
    }

    bulkSyncStatus.totalUsers = verifiedMembers.length;
    console.log(`Starting sync for ${verifiedMembers.length} verified members`);

    let successCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    let totalChanges = 0;

    // Process users in batches to avoid overwhelming the API
    const BATCH_SIZE = 10;
    for (let i = 0; i < verifiedMembers.length; i += BATCH_SIZE) {
      // Check for stop signal
      if (bulkSyncStatus.shouldStop) {
        console.log("🛑 Sync stopped by user request");
        break;
      }

      const batch = verifiedMembers.slice(i, i + BATCH_SIZE);

      console.log(
        `Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${
          Math.ceil(verifiedMembers.length / BATCH_SIZE)
        } (users ${i + 1}-${
          Math.min(i + BATCH_SIZE, verifiedMembers.length)
        }/${verifiedMembers.length})`,
      );

      for (let j = 0; j < batch.length; j++) {
        const userId = batch[j];
        const userNumber = i + j + 1; // Current user number

        // Check for stop signal before each user
        if (bulkSyncStatus.shouldStop) {
          console.log("🛑 Sync stopped by user request");
          break;
        }

        const result = await syncUserRoles(
          guildId,
          userId,
          userNumber,
          verifiedMembers.length,
          false,
          true,
        );
        bulkSyncStatus.processedUsers++;

        if (result.success) {
          successCount++;
          if (result.skipped) {
            skippedCount++;
          } else {
            totalChanges += result.changes.length;

            if (result.changes.length > 0) {
              console.log(
                `👤 User ${userId} (${userNumber}/${verifiedMembers.length}): ${
                  result.changes.join(", ")
                }`,
              );
            }
          }
        } else {
          errorCount++;
        }

        // Delay between users to respect rate limits
        await new Promise((resolve) =>
          setTimeout(resolve, SYNC_CONFIG.DELAY_BETWEEN_USERS)
        );
      }

      // Break out of batch loop if stopped
      if (bulkSyncStatus.shouldStop) break;

      // Longer delay between batches
      await new Promise((resolve) =>
        setTimeout(resolve, SYNC_CONFIG.DELAY_BETWEEN_BATCHES)
      );
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    const status = bulkSyncStatus.shouldStop ? "stopped" : "complete";
    console.log(`=== Sync ${status} ===`);
    console.log(`Duration: ${duration}s`);
    console.log(`Processed: ${successCount} users`);
    console.log(`Skipped (cached): ${skippedCount} users`);
    console.log(`Errors: ${errorCount} users`);
    console.log(`Total changes: ${totalChanges}`);

    // Log cache stats
    const cacheStats = await getCacheStats();
    console.log(`Total cache entries: ${cacheStats.totalCached}`);
  } catch (error) {
    console.error("Error during sync:", error);
  } finally {
    // Reset sync status
    resetBulkSyncStatus();
  }
}

// Function to trigger a sync for any guild at any time
export async function triggerRoleSync(guildId?: string): Promise<void> {
  const targetGuildId = guildId || Deno.env.get("DISCORD_GUILD_ID");

  if (!targetGuildId) {
    console.error(
      "No guild ID provided and DISCORD_GUILD_ID environment variable not set",
    );
    return;
  }

  console.log(`Triggering role sync for guild: ${targetGuildId}`);
  await performSyncForGuild(targetGuildId);
}

// Chunked sync function for Deno Deploy compatibility
export async function triggerChunkedRoleSync(
  guildId?: string,
  startIndex = 0,
  chunkSize = SYNC_CONFIG.CHUNK_SIZE,
  logPrefix = "",
): Promise<{ completed: boolean; nextIndex: number; totalUsers: number }> {
  const targetGuildId = guildId || Deno.env.get("DISCORD_GUILD_ID");

  if (!targetGuildId) {
    console.error(
      `${logPrefix}No guild ID provided and DISCORD_GUILD_ID environment variable not set`,
    );
    return { completed: true, nextIndex: 0, totalUsers: 0 };
  }

  console.log(
    `${logPrefix}🚀 Starting chunked sync for guild: ${targetGuildId}, startIndex: ${startIndex}, chunkSize: ${chunkSize}`,
  );
  return await performChunkedSyncForGuild(
    targetGuildId,
    startIndex,
    chunkSize,
    logPrefix,
  );
}

// Core chunked sync logic optimized for Deno Deploy
async function performChunkedSyncForGuild(
  guildId: string,
  startIndex: number,
  chunkSize: number,
  logPrefix = "",
): Promise<{ completed: boolean; nextIndex: number; totalUsers: number }> {
  // Check if already running
  if (bulkSyncStatus.isRunning) {
    console.log(`${logPrefix}Sync already in progress, skipping`);
    return { completed: false, nextIndex: startIndex, totalUsers: 0 };
  }

  // Initialize sync status
  bulkSyncStatus.isRunning = true;
  bulkSyncStatus.shouldStop = false;
  bulkSyncStatus.currentGuild = guildId;
  bulkSyncStatus.startTime = Date.now();
  bulkSyncStatus.lastProcessedIndex = startIndex;

  console.log(`${logPrefix}=== Starting chunked role synchronization ===`);
  const executionStartTime = Date.now();

  try {
    // Get all verified members
    const verifiedMembers = await getVerifiedMembers(guildId);

    if (verifiedMembers.length === 0) {
      console.log(`${logPrefix}No verified members found, sync complete`);
      return { completed: true, nextIndex: 0, totalUsers: 0 };
    }

    bulkSyncStatus.totalUsers = verifiedMembers.length;
    const endIndex = Math.min(startIndex + chunkSize, verifiedMembers.length);
    const chunkMembers = verifiedMembers.slice(startIndex, endIndex);

    console.log(
      `${logPrefix}📊 Processing chunk: ${startIndex}-${
        endIndex - 1
      } of ${verifiedMembers.length} total users (${chunkMembers.length} in this chunk)`,
    );

    let successCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    let totalChanges = 0;

    // Process users in batches within the chunk
    const BATCH_SIZE = SYNC_CONFIG.BATCH_SIZE;
    for (let i = 0; i < chunkMembers.length; i += BATCH_SIZE) {
      // Check execution time limit
      const elapsed = Date.now() - executionStartTime;
      if (elapsed > SYNC_CONFIG.MAX_EXECUTION_TIME) {
        console.warn(
          `${logPrefix}⏰ Execution time limit reached (${elapsed}ms), stopping chunk processing`,
        );
        const processedInChunk = i;
        const actualNextIndex = startIndex + processedInChunk;
        return {
          completed: actualNextIndex >= verifiedMembers.length,
          nextIndex: actualNextIndex,
          totalUsers: verifiedMembers.length,
        };
      }

      // Check for stop signal
      if (bulkSyncStatus.shouldStop) {
        console.log(`${logPrefix}🛑 Sync stopped by user request`);
        const processedInChunk = i;
        const actualNextIndex = startIndex + processedInChunk;
        return {
          completed: false,
          nextIndex: actualNextIndex,
          totalUsers: verifiedMembers.length,
        };
      }

      const batch = chunkMembers.slice(i, i + BATCH_SIZE);
      bulkSyncStatus.currentBatch = Math.floor((startIndex + i) / BATCH_SIZE);

      console.log(
        `${logPrefix}Processing batch ${
          bulkSyncStatus.currentBatch + 1
        } (${batch.length} users)`,
      );

      for (let j = 0; j < batch.length; j++) {
        const userId = batch[j];
        const userNumber = startIndex + i + j + 1; // Current user number in overall sync

        // Check for stop signal before each user
        if (bulkSyncStatus.shouldStop) {
          console.log(`${logPrefix}🛑 Sync stopped by user request`);
          break;
        }

        const result = await syncUserRoles(
          guildId,
          userId,
          userNumber,
          verifiedMembers.length,
          false,
          true,
        );
        bulkSyncStatus.processedUsers = startIndex + i + j + 1;
        bulkSyncStatus.lastProcessedIndex = bulkSyncStatus.processedUsers - 1;

        if (result.success) {
          successCount++;
          if (result.skipped) {
            skippedCount++;
          } else {
            totalChanges += result.changes.length;

            if (result.changes.length > 0) {
              console.log(
                `${logPrefix}👤 User ${userId} (${userNumber}/${verifiedMembers.length}): ${
                  result.changes.join(", ")
                }`,
              );
            }
          }
        } else {
          errorCount++;
        }

        // Delay between users to respect rate limits
        await new Promise((resolve) =>
          setTimeout(resolve, SYNC_CONFIG.DELAY_BETWEEN_USERS)
        );
      }

      // Break out of batch loop if stopped
      if (bulkSyncStatus.shouldStop) break;

      // Longer delay between batches
      await new Promise((resolve) =>
        setTimeout(resolve, SYNC_CONFIG.DELAY_BETWEEN_BATCHES)
      );
    }

    const duration = ((Date.now() - executionStartTime) / 1000).toFixed(2);
    const nextIndex = endIndex;
    const isCompleted = nextIndex >= verifiedMembers.length;

    console.log(
      `${logPrefix}=== Chunk ${isCompleted ? "complete" : "processed"} ===`,
    );
    console.log(`${logPrefix}Duration: ${duration}s`);
    console.log(`${logPrefix}Chunk processed: ${successCount} users`);
    console.log(`${logPrefix}Chunk skipped (cached): ${skippedCount} users`);
    console.log(`${logPrefix}Chunk errors: ${errorCount} users`);
    console.log(`${logPrefix}Chunk changes: ${totalChanges}`);
    console.log(
      `${logPrefix}Overall progress: ${nextIndex}/${verifiedMembers.length} (${
        ((nextIndex / verifiedMembers.length) * 100).toFixed(1)
      }%)`,
    );

    // Log cache stats for completed chunks
    if (isCompleted) {
      const cacheStats = await getCacheStats();
      console.log(`${logPrefix}Total cache entries: ${cacheStats.totalCached}`);
    }

    if (!isCompleted) {
      console.log(
        `${logPrefix}🔄 Next chunk should start at index ${nextIndex}`,
      );

      // Auto-trigger next chunk after a delay (optional)
      if (Deno.env.get("AUTO_CONTINUE_CHUNKS") === "true") {
        console.log(
          `${logPrefix}🔗 Auto-triggering next chunk in 10 seconds...`,
        );
        setTimeout(() => {
          triggerChunkedRoleSync(guildId, nextIndex, chunkSize, logPrefix)
            .catch((error) => {
              console.error(
                `${logPrefix}Error in auto-triggered next chunk:`,
                error,
              );
            });
        }, 10000);
      }
    }

    return {
      completed: isCompleted,
      nextIndex,
      totalUsers: verifiedMembers.length,
    };
  } catch (error) {
    console.error(`${logPrefix}Error during chunked sync:`, error);
    return { completed: false, nextIndex: startIndex, totalUsers: 0 };
  } finally {
    // Reset sync status
    resetBulkSyncStatus();
  }
}

// Note: Automatic daily sync has been removed for reliability
// Available sync options:
// 1. Manual Discord command: /ethos_sync
// 2. HTTP endpoints: POST /trigger-sync (for chunked processing)
// 3. Sync helper script: deno run --allow-net --allow-env sync-helper.ts complete
// 4. External automation: cron jobs, GitHub Actions, etc.

// Helper function to get role name from role ID
function getRoleNameFromId(roleId: string): string {
  if (roleId === ETHOS_VERIFIED_ROLE_ID) return "Verified";
  if (roleId === ETHOS_VERIFIED_PROFILE_ROLE_ID) return "Verified Profile";
  if (ETHOS_VALIDATOR_META_ROLE_ID && roleId === ETHOS_VALIDATOR_META_ROLE_ID) return "Validator";
  if (ETHOS_HUMAN_VERIFIED_META_ROLE_ID && roleId === ETHOS_HUMAN_VERIFIED_META_ROLE_ID) return "Human Verified";
  if (ETHOS_HUMAN_VALIDATOR_META_ROLE_ID && roleId === ETHOS_HUMAN_VALIDATOR_META_ROLE_ID) return "Human Validator";

  // Reverse lookup from roleRegistry
  for (const [key, id] of roleRegistry) {
    if (id === roleId) {
      const [tierName, variantKey] = key.split(":");
      const variant = BADGE_VARIANTS.find((v) => v.key === variantKey);
      return `${tierName}${variant?.suffix || ""}`;
    }
  }

  // Check legacy IDs
  for (const [key, id] of Object.entries(LEGACY_ROLE_IDS)) {
    if (id === roleId) {
      const [tierName, variantKey] = key.split(":");
      const variant = BADGE_VARIANTS.find((v) => v.key === variantKey);
      return `${tierName}${variant?.suffix || ""}`;
    }
  }

  return "Unknown";
}

// ===== VALIDATOR VERIFICATION SYSTEM =====

// Configuration for validator verification
const VALIDATOR_CHECK_CONFIG = {
  BATCH_SIZE: 5, // Smaller batches for validator checks
  DELAY_BETWEEN_USERS: 3000, // 3 seconds between checks
  DELAY_BETWEEN_BATCHES: 10000, // 10 seconds between batches
  MAX_EXECUTION_TIME: 10 * 60 * 1000, // 10 minutes max execution
};

// Global validator check state
let validatorCheckStatus = {
  isRunning: false,
  shouldStop: false,
  currentGuild: null as string | null,
  startTime: null as number | null,
  processedUsers: 0,
  totalUsers: 0,
  demotedUsers: 0,
  lastProcessedIndex: 0,
  checkId: null as string | null,
};

// Function to get all validator role IDs
// Get all non-base role IDs (validator, human, human_validator) from registry + legacy
function getAllSpecialRoles(): string[] {
  const ids: string[] = [];
  for (const [key, id] of roleRegistry) {
    if (!key.endsWith(":base")) ids.push(id);
  }
  for (const [key, id] of Object.entries(LEGACY_ROLE_IDS)) {
    if (!key.endsWith(":base") && !ids.includes(id)) ids.push(id);
  }
  return ids;
}




// Function to get all users with validator roles
async function getUsersWithValidatorRoles(guildId: string): Promise<{userId: string, validatorRoles: string[]}[]> {
  try {
    console.log("[VALIDATOR-CHECK] Fetching users with special (non-base) roles from guild:", guildId);

    // Get all members from the guild
    const url = `https://discord.com/api/v10/guilds/${guildId}/members?limit=1000`;
    const response = await discordApiCall(url, { method: "GET" });

    if (!response.ok) {
      console.error(`[VALIDATOR-CHECK] Failed to fetch guild members: ${response.status}`);
      return [];
    }

    const members = await response.json();
    const specialRoleIds = getAllSpecialRoles();
    const usersWithValidatorRoles: {userId: string, validatorRoles: string[]}[] = [];

    // Filter members who have any special roles (validator, human, human_validator)
    for (const member of members) {
      const memberSpecialRoles = member.roles.filter((roleId: string) =>
        specialRoleIds.includes(roleId)
      );

      if (memberSpecialRoles.length > 0) {
        usersWithValidatorRoles.push({
          userId: member.user.id,
          validatorRoles: memberSpecialRoles
        });
      }
    }

    console.log(`[VALIDATOR-CHECK] Found ${usersWithValidatorRoles.length} users with special roles`);
    return usersWithValidatorRoles;
  } catch (error) {
    console.error("[VALIDATOR-CHECK] Error fetching users with validator roles:", error);
    return [];
  }
}

// Function to verify and potentially re-sync a single user's special role
async function verifyUserValidator(
  guildId: string,
  userId: string,
  validatorRoles: string[],
  userNumber?: number,
  totalUsers?: number
): Promise<{ success: boolean; changes: string[]; demoted: boolean }> {
  try {
    const progressPrefix = userNumber && totalUsers ? `[${userNumber}/${totalUsers}] ` : "";
    console.log(`${progressPrefix}[STATUS-CHECK] Checking status for user: ${userId}`);

    // Check both validator and human verification status
    const { hasValidator, isHumanVerified } = await getUserVerificationStatus(userId);

    // Get user's current Ethos profile to determine correct role
    const profile = await fetchEthosProfileByDiscord(userId);
    const changes: string[] = [];

    let targetRoleId: string | null = null;
    if (!("error" in profile) && typeof profile.score === "number") {
      // Determine which variant the user should have
      const tier = getTierForScore(profile.score);
      let variant: string;
      if (tier.name === "Untrusted") {
        variant = "base";
      } else if (hasValidator && isHumanVerified) {
        variant = "human_validator";
      } else if (isHumanVerified) {
        variant = "human";
      } else if (hasValidator) {
        variant = "validator";
      } else {
        variant = "base";
      }
      targetRoleId = getRoleIdForScore(profile.score, variant);
    } else {
      targetRoleId = getRoleIdForScore(0, "base"); // Untrusted base
    }

    // Check if user already has the correct role
    if (targetRoleId && validatorRoles.length === 1 && validatorRoles[0] === targetRoleId) {
      console.log(`${progressPrefix}[STATUS-CHECK] User ${userId} already has correct role, no changes needed`);
      return { success: true, changes: [], demoted: false };
    }

    // Remove current special roles
    for (const roleId of validatorRoles) {
      const removeUrl = `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`;
      const removeResponse = await discordApiCall(removeUrl, { method: "DELETE" });

      if (removeResponse.ok) {
        const roleName = getRoleNameFromId(roleId);
        changes.push(`Removed ${roleName} role`);
        console.log(`${progressPrefix}[STATUS-CHECK] Removed role ${roleName} from user ${userId}`);
      }

      await new Promise(resolve => setTimeout(resolve, VALIDATOR_CHECK_CONFIG.DELAY_BETWEEN_USERS / 4));
    }

    // Add the correct role
    if (targetRoleId) {
      const addUrl = `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${targetRoleId}`;
      const addResponse = await discordApiCall(addUrl, { method: "PUT" });

      if (addResponse.ok) {
        const roleName = getRoleNameFromId(targetRoleId);
        changes.push(`Added ${roleName} role`);
        console.log(`${progressPrefix}[STATUS-CHECK] Added role ${roleName} to user ${userId}`);
      }
    }

    // Send webhook notification
    if (changes.length > 0) {
      const statusParts = [];
      if (hasValidator) statusParts.push("Validator");
      if (isHumanVerified) statusParts.push("Human Verified");
      await sendRoleChangeWebhook(userId, changes, "status-check", {
        profileInfo: !("error" in profile) && typeof profile.score === "number"
          ? `Score: ${profile.score} - ${statusParts.join(" + ") || "No special status"}`
          : "Status re-verified",
        guildId: guildId,
        processedCount: userNumber,
        totalCount: totalUsers,
      });
    }

    const demoted = changes.some(c => c.startsWith("Removed"));
    return { success: true, changes, demoted };

  } catch (error) {
    const progressPrefix = userNumber && totalUsers ? `[${userNumber}/${totalUsers}] ` : "";
    console.error(`${progressPrefix}[VALIDATOR-CHECK] Error verifying validator for user ${userId}:`, error);
    return { success: false, changes: [], demoted: false };
  }
}

// Main validator verification function
async function performValidatorVerification(guildId: string): Promise<void> {
  // Check if already running
  if (validatorCheckStatus.isRunning) {
    console.log("[VALIDATOR-CHECK] Validator verification already in progress, skipping");
    return;
  }

  // Initialize status
  validatorCheckStatus.isRunning = true;
  validatorCheckStatus.shouldStop = false;
  validatorCheckStatus.currentGuild = guildId;
  validatorCheckStatus.startTime = Date.now();
  validatorCheckStatus.processedUsers = 0;
  validatorCheckStatus.totalUsers = 0;
  validatorCheckStatus.demotedUsers = 0;
  validatorCheckStatus.checkId = `validator_check_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  console.log("[VALIDATOR-CHECK] === Starting validator verification ===");
  const startTime = Date.now();

  try {
    // Get all users with validator roles
    const usersWithValidatorRoles = await getUsersWithValidatorRoles(guildId);

    if (usersWithValidatorRoles.length === 0) {
      console.log("[VALIDATOR-CHECK] No users with validator roles found, verification complete");
      return;
    }

    validatorCheckStatus.totalUsers = usersWithValidatorRoles.length;
    console.log(`[VALIDATOR-CHECK] Starting verification for ${usersWithValidatorRoles.length} users with validator roles`);

    let successCount = 0;
    let errorCount = 0;
    let demotedCount = 0;
    let totalChanges = 0;
    const purgedUserIds: string[] = [];

    // Process users in batches
    const BATCH_SIZE = VALIDATOR_CHECK_CONFIG.BATCH_SIZE;
    for (let i = 0; i < usersWithValidatorRoles.length; i += BATCH_SIZE) {
      // Check for stop signal
      if (validatorCheckStatus.shouldStop) {
        console.log("[VALIDATOR-CHECK] 🛑 Verification stopped by user request");
        break;
      }

      // Check execution time limit
      const elapsed = Date.now() - startTime;
      if (elapsed > VALIDATOR_CHECK_CONFIG.MAX_EXECUTION_TIME) {
        console.warn(`[VALIDATOR-CHECK] ⏰ Execution time limit reached (${elapsed}ms), stopping verification`);
        break;
      }

      const batch = usersWithValidatorRoles.slice(i, i + BATCH_SIZE);
      console.log(
        `[VALIDATOR-CHECK] Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(usersWithValidatorRoles.length / BATCH_SIZE)} (users ${i + 1}-${Math.min(i + BATCH_SIZE, usersWithValidatorRoles.length)}/${usersWithValidatorRoles.length})`
      );

      for (let j = 0; j < batch.length; j++) {
        const { userId, validatorRoles } = batch[j];
        const userNumber = i + j + 1;

        // Check for stop signal before each user
        if (validatorCheckStatus.shouldStop) {
          console.log("[VALIDATOR-CHECK] 🛑 Verification stopped by user request");
          break;
        }

        const result = await verifyUserValidator(guildId, userId, validatorRoles, userNumber, usersWithValidatorRoles.length);
        validatorCheckStatus.processedUsers++;

        if (result.success) {
          successCount++;
          if (result.demoted) {
            demotedCount++;
            validatorCheckStatus.demotedUsers++;
            purgedUserIds.push(userId);
          }
          totalChanges += result.changes.length;

          if (result.changes.length > 0) {
            console.log(`[VALIDATOR-CHECK] 👤 User ${userId} (${userNumber}/${usersWithValidatorRoles.length}): ${result.changes.join(", ")}`);
          }
        } else {
          errorCount++;
        }

        // Delay between users
        await new Promise(resolve => setTimeout(resolve, VALIDATOR_CHECK_CONFIG.DELAY_BETWEEN_USERS));
      }

      // Break out of batch loop if stopped
      if (validatorCheckStatus.shouldStop) break;

      // Longer delay between batches
      await new Promise(resolve => setTimeout(resolve, VALIDATOR_CHECK_CONFIG.DELAY_BETWEEN_BATCHES));
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    const status = validatorCheckStatus.shouldStop ? "stopped" : "complete";
    console.log(`[VALIDATOR-CHECK] === Validator verification ${status} ===`);
    console.log(`[VALIDATOR-CHECK] Duration: ${duration}s`);
    console.log(`[VALIDATOR-CHECK] Processed: ${successCount} users`);
    console.log(`[VALIDATOR-CHECK] Demoted: ${demotedCount} users`);
    console.log(`[VALIDATOR-CHECK] Errors: ${errorCount} users`);
    console.log(`[VALIDATOR-CHECK] Total changes: ${totalChanges}`);

    // Post purge summary to the validator channel
    const VALIDATOR_PURGE_CHANNEL_ID = "1377481679567851562";
    try {
      let message: string;
      if (purgedUserIds.length === 0) {
        message = `Purge complete. Checked ${successCount} users — no one was removed.`;
      } else {
        const purgedMentions = purgedUserIds.map(id => `<@${id}>`).join(", ");
        message = `Purge complete. Checked ${successCount} users — ${purgedUserIds.length} removed:\n${purgedMentions}`;
      }
      await sendGatewayChannelMessage(VALIDATOR_PURGE_CHANNEL_ID, message);
      console.log(`[VALIDATOR-CHECK] Posted purge summary to channel ${VALIDATOR_PURGE_CHANNEL_ID}`);
    } catch (msgError) {
      console.error("[VALIDATOR-CHECK] Failed to post purge summary:", msgError);
    }

  } catch (error) {
    console.error("[VALIDATOR-CHECK] Error during validator verification:", error);
  } finally {
    // Reset status
    validatorCheckStatus = {
      isRunning: false,
      shouldStop: false,
      currentGuild: null,
      startTime: null,
      processedUsers: 0,
      totalUsers: 0,
      demotedUsers: 0,
      lastProcessedIndex: 0,
      checkId: null,
    };
  }
}

// Function to stop validator verification
export function stopValidatorCheck(): boolean {
  if (validatorCheckStatus.isRunning) {
    console.log("[VALIDATOR-CHECK] Stop signal sent to running validator verification");
    validatorCheckStatus.shouldStop = true;
    return true;
  }
  return false;
}

// Function to get validator check status
export function getValidatorCheckStatus() {
  return {
    ...validatorCheckStatus,
    duration: validatorCheckStatus.startTime ? Date.now() - validatorCheckStatus.startTime : 0,
  };
}

// Function to trigger validator verification
export async function triggerValidatorVerification(guildId?: string): Promise<void> {
  const targetGuildId = guildId || Deno.env.get("DISCORD_GUILD_ID");

  if (!targetGuildId) {
    console.error("[VALIDATOR-CHECK] No guild ID provided and DISCORD_GUILD_ID environment variable not set");
    return;
  }

  console.log(`[VALIDATOR-CHECK] Triggering validator verification for guild: ${targetGuildId}`);
  await performValidatorVerification(targetGuildId);
}

// ===== DAILY VALIDATOR PURGE =====

// Run validator verification once every 24 hours
const DAILY_VALIDATOR_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
setTimeout(() => {
  // Initial run 5 minutes after startup to let everything initialize
  triggerValidatorVerification().catch(error => {
    console.error("[DAILY-PURGE] Error in initial validator verification:", error);
  });

  // Then repeat every 24 hours
  setInterval(() => {
    triggerValidatorVerification().catch(error => {
      console.error("[DAILY-PURGE] Error in scheduled validator verification:", error);
    });
  }, DAILY_VALIDATOR_CHECK_INTERVAL);
}, 5 * 60 * 1000); // 5 minute startup delay

console.log("ℹ️ Daily validator purge scheduled (first run 5 min after startup, then every 24h)");
console.log("ℹ️ - Manual trigger: POST /trigger-validator-check");
console.log("ℹ️ - Manual role init: POST /initialize-roles");

// ===== BATCH API FUNCTIONS =====

// Hybrid batch API function with fallback to individual APIs
async function fetchEthosProfilesBatch(userIds: string[]): Promise<Map<string, any>> {
  try {
    console.log(`[BATCH] Fetching profiles for ${userIds.length} users`);
    
    // Convert Discord user IDs to userkeys for score API
    const userkeys = userIds.map(id => `service:discord:${id}`);
    
    // Batch fetch scores and stats (up to 500 users each)
    const [scoresResponse, statsResponse] = await Promise.all([
      fetch(`https://api.ethos.network/api/v2/score/userkeys`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "X-Ethos-Client": "ethos-discord",
        },
        body: JSON.stringify({ userkeys })
      }),
      fetch(`https://api.ethos.network/api/v2/users/by/discord`, {
        method: "POST", 
        headers: { 
          "Content-Type": "application/json",
          "X-Ethos-Client": "ethos-discord",
        },
        body: JSON.stringify({ discordIds: userIds })  // Use raw Discord IDs
      })
    ]);

    const results = new Map<string, any>();
    const usersNeedingFallback = new Set<string>();

    // Process scores response with better error handling
    if (scoresResponse.ok) {
      try {
        const scoresData = await scoresResponse.json();
        console.log(`[BATCH] Scores response structure:`, Object.keys(scoresData).slice(0, 3));
        
        // Handle different possible response structures
        const scoreEntries = scoresData.data || scoresData;
        const scoreCount = Array.isArray(scoreEntries) ? scoreEntries.length : Object.keys(scoreEntries).length;
        console.log(`[BATCH] Got scores for ${scoreCount} users`);
        
        if (Array.isArray(scoreEntries)) {
          // Array format: [{userkey: "service:discord:123", score: 1500, ...}, ...]
          for (const scoreEntry of scoreEntries) {
            if (scoreEntry.userkey && scoreEntry.userkey.startsWith('service:discord:')) {
              const userId = scoreEntry.userkey.replace('service:discord:', '');
              results.set(userId, { 
                score: scoreEntry.score, 
                level: scoreEntry.level,
                hasProfile: true 
              });
              console.log(`[BATCH] User ${userId}: score=${scoreEntry.score}, level=${scoreEntry.level}`);
            }
          }
        } else {
          // Object format: {"service:discord:123": {score: 1500, ...}, ...}
          for (const [userkey, scoreData] of Object.entries(scoreEntries)) {
            if (userkey.startsWith('service:discord:')) {
              const userId = userkey.replace('service:discord:', '');
              const data = scoreData as any;
              results.set(userId, { 
                score: data.score, 
                level: data.level,
                hasProfile: true 
              });
              console.log(`[BATCH] User ${userId}: score=${data.score}, level=${data.level}`);
            }
          }
        }
      } catch (error) {
        console.error(`[BATCH] Error parsing scores response:`, error);
        // Add all users to fallback list if batch scores fail
        for (const userId of userIds) {
          usersNeedingFallback.add(userId);
        }
      }
    } else {
      console.error(`[BATCH] Scores API failed: ${scoresResponse.status} ${scoresResponse.statusText}`);
      // Add all users to fallback list if batch scores fail
      for (const userId of userIds) {
        usersNeedingFallback.add(userId);
      }
    }

    // Process stats response with better error handling
    if (statsResponse.ok) {
      try {
        const statsData = await statsResponse.json();
        console.log(`[BATCH] Stats response structure:`, Array.isArray(statsData) ? 'array' : 'object');
        
        // Handle different possible response structures
        const statsEntries = statsData.data || statsData;
        const statsArray = Array.isArray(statsEntries) ? statsEntries : [statsEntries];
        console.log(`[BATCH] Got stats for ${statsArray.length} users`);
        
        // Track which users got stats data
        const usersWithStats = new Set<string>();
        
        for (const userStats of statsArray) {
          if (!userStats) continue;
          
          // Extract Discord ID from userkeys  
          const discordUserkey = userStats.userkeys?.find((uk: string) => uk.startsWith('service:discord:'));
          if (discordUserkey) {
            const userId = discordUserkey.replace('service:discord:', '');
            const existing = results.get(userId) || { hasProfile: false };
            
            // Handle new Discord API response structure
            const totalReviews = (userStats.stats?.review?.received?.positive || 0) + 
                                (userStats.stats?.review?.received?.negative || 0) + 
                                (userStats.stats?.review?.received?.neutral || 0);
            const positiveReviews = userStats.stats?.review?.received?.positive || 0;
            const vouchCount = userStats.stats?.vouch?.received?.count || 0;
            const positivePercentage = totalReviews > 0 ? (positiveReviews / totalReviews) * 100 : 0;
            
            // Check if user has any Ethereum addresses (indicates primary address exists)
            const hasEthAddress = userStats.userkeys?.some((uk: string) => uk.startsWith('address:'));
            
            // Extract human verification and validator status
            const humanVerificationStatus = userStats.humanVerificationStatus || null;
            const validatorNftCount = userStats.validatorNftCount || 0;

            results.set(userId, {
              ...existing,
              elements: {
                totalReviews,
                vouchCount,
                positivePercentage,
              },
              primaryAddress: hasEthAddress ? "detected" : undefined,
              humanVerificationStatus,
              validatorNftCount,
            });

            usersWithStats.add(userId);
            console.log(`[BATCH] User ${userId}: reviews=${totalReviews}, vouches=${vouchCount}, address=${hasEthAddress ? 'yes' : 'no'}, humanVerified=${humanVerificationStatus}, validators=${validatorNftCount}`);
          }
        }
        
        // Mark users without stats data for fallback
        for (const userId of userIds) {
          if (results.has(userId) && !usersWithStats.has(userId)) {
            console.log(`[BATCH] User ${userId} missing stats data, marking for fallback`);
            usersNeedingFallback.add(userId);
          }
        }
        
      } catch (error) {
        console.error(`[BATCH] Error parsing stats response:`, error);
        // Mark all users with profiles for fallback if stats parsing fails
        for (const userId of userIds) {
          if (results.has(userId)) {
            usersNeedingFallback.add(userId);
          }
        }
      }
    } else {
      console.error(`[BATCH] Stats API failed: ${statsResponse.status} ${statsResponse.statusText}`);
      // Mark all users with profiles for fallback if stats API fails
      for (const userId of userIds) {
        if (results.has(userId)) {
          usersNeedingFallback.add(userId);
        }
      }
    }

    // Fallback to individual APIs for users with incomplete data
    if (usersNeedingFallback.size > 0) {
      console.log(`[BATCH] Using individual API fallback for ${usersNeedingFallback.size} users`);
      
      for (const userId of usersNeedingFallback) {
        try {
          const userkey = `service:discord:${userId}`;
          
          // Fetch individual profile data
          const [individualScoreResponse, individualStatsResponse] = await Promise.all([
            fetch(`https://api.ethos.network/api/v1/score/${userkey}`, {
              headers: {
                "X-Ethos-Client": "ethos-discord",
              },
            }),
            fetch(`https://api.ethos.network/api/v1/users/${userkey}/stats`, {
              headers: {
                "X-Ethos-Client": "ethos-discord",
              },
            })
          ]);
          
          let profileData: any = { hasProfile: false };
          
          // Process individual score
          if (individualScoreResponse.ok) {
            const scoreData = await individualScoreResponse.json();
            if (scoreData.ok && scoreData.data) {
              profileData = {
                score: scoreData.data.score,
                level: scoreData.data.level,
                hasProfile: true,
                elements: {} // Initialize elements
              };
            }
          }
          
          // Process individual stats
          if (individualStatsResponse.ok && profileData.hasProfile) {
            const statsData = await individualStatsResponse.json();
            if (statsData.ok && statsData.data) {
              profileData.elements = {
                totalReviews: statsData.data.reviews?.received || 0,
                vouchCount: statsData.data.vouches?.count?.received || 0,
                positivePercentage: statsData.data.reviews?.positiveReviewPercentage || 0,
              };
              
              // Set primaryAddress based on vouches (if they have vouches, they likely have an address)
              profileData.primaryAddress = (statsData.data.vouches?.count?.received > 0) ? "unknown" : undefined;
            }
          }
          
          results.set(userId, profileData);
          console.log(`[BATCH] Fallback for user ${userId}: score=${profileData.score}, reviews=${profileData.elements?.totalReviews}, vouches=${profileData.elements?.vouchCount}`);
          
          // Small delay between individual API calls
          await new Promise(resolve => setTimeout(resolve, 100));
          
        } catch (error) {
          console.error(`[BATCH] Fallback failed for user ${userId}:`, error);
          results.set(userId, { hasProfile: false, error: "Fallback failed" });
        }
      }
    }

    // For users not found in any API responses, mark as no profile
    for (const userId of userIds) {
      if (!results.has(userId)) {
        results.set(userId, { hasProfile: false, error: "No profile found" });
        console.log(`[BATCH] User ${userId}: No profile found`);
      }
    }

    console.log(`[BATCH] Final results: ${results.size} total users processed, ${usersNeedingFallback.size} used fallback`);
    return results;
    
  } catch (error) {
    console.error("[BATCH] Error fetching batch profiles:", error);
    return new Map(); // Return empty map on error
  }
}

// Function to check if a Discord user has an Ethos profile
async function checkUserHasEthosProfile(userId: string): Promise<boolean> {
  try {
    console.log(
      "Checking if Discord user with ID has an Ethos profile:",
      userId,
    );

    // Make sure we're just using the raw ID without any @ symbol
    const cleanUserId = userId.replace("@", "").replace("<", "").replace(
      ">",
      "",
    );
    console.log("Clean User ID:", cleanUserId);

    // Use the Ethos API with the Discord ID - ensure proper format
    const userkey = `service:discord:${cleanUserId}`;

    // First fetch the user's addresses to see if they have an Ethos profile
    const profileResponse = await fetch(
      `https://api.ethos.network/api/v1/score/${userkey}`,
      {
        headers: {
          "X-Ethos-Client": "ethos-discord",
        },
      },
    );

    // If we get a 200 OK response, the user has a profile
    return profileResponse.ok;
  } catch (error) {
    console.error("Error checking if user has Ethos profile:", error);
    return false;
  }
}

// Optimized batch sync function using batch APIs
async function syncUserRolesBatch(
  guildId: string,
  userIds: string[],
  forceSync = false,
): Promise<{ success: boolean; changes: Map<string, string[]>; errors: string[] }> {
  // Wait for role initialization if pending
  if (roleInitPromise) await roleInitPromise;

  try {
    console.log(`[BATCH-SYNC] Starting batch sync for ${userIds.length} users`);

    // Filter out recently synced users (unless forced)
    let usersToSync = userIds;
    if (!forceSync) {
      const filteredUsers = [];
      for (const userId of userIds) {
        const recentlySynced = await wasRecentlySynced(userId);
        if (!recentlySynced) {
          filteredUsers.push(userId);
        }
      }
      usersToSync = filteredUsers;
      console.log(`[BATCH-SYNC] After cache filter: ${usersToSync.length} users need sync`);
    }

    if (usersToSync.length === 0) {
      return { success: true, changes: new Map(), errors: [] };
    }

    // Batch fetch all user profiles (up to 500 at a time)
    const batchSize = 500;
    const allProfileData = new Map<string, any>();
    
    for (let i = 0; i < usersToSync.length; i += batchSize) {
      const batch = usersToSync.slice(i, i + batchSize);
      const batchProfiles = await fetchEthosProfilesBatch(batch);
      
      // Merge results
      for (const [userId, profile] of batchProfiles) {
        allProfileData.set(userId, profile);
      }
      
      // Small delay between batch requests
      if (i + batchSize < usersToSync.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    console.log(`[BATCH-SYNC] Profile data summary:`);
    for (const [userId, profile] of allProfileData.entries()) {
      console.log(`[BATCH-SYNC] User ${userId}: hasProfile=${profile.hasProfile}, score=${profile.score}, humanVerified=${profile.humanVerificationStatus}, validators=${profile.validatorNftCount}`);
    }

    // Sort users by score descending — highest scores get processed first
    const sortedUsers = [...usersToSync].sort((a, b) => {
      const scoreA = allProfileData.get(a)?.score ?? -1;
      const scoreB = allProfileData.get(b)?.score ?? -1;
      return scoreB - scoreA;
    });
    console.log(`[BATCH-SYNC] Processing users sorted by score (highest first)`);

    // Now process role changes for each user
    const changes = new Map<string, string[]>();
    const errors: string[] = [];
    let processedCount = 0;

    for (const userId of sortedUsers) {
      try {
        processedCount++;
        const profile = allProfileData.get(userId);
        
        if (processedCount % 50 === 0) {
          console.log(`[BATCH-SYNC] Processed ${processedCount}/${usersToSync.length} users`);
        }

        // Get user's current Discord roles
        const memberUrl = `https://discord.com/api/v10/guilds/${guildId}/members/${userId}`;
        const memberResponse = await discordApiCall(memberUrl, { method: "GET" });

        if (!memberResponse.ok) {
          errors.push(`Failed to fetch member ${userId}: ${memberResponse.status}`);
          continue;
        }

        const memberData = await memberResponse.json();
        const currentRoles = memberData.roles || [];
        const currentEthosRoles = getCurrentEthosRoles(currentRoles);

        // Determine expected roles based on profile data
        let expectedRoles = [ETHOS_VERIFIED_ROLE_ID]; // Always has basic verified role
        
        console.log(`[BATCH-SYNC] User ${userId} role calculation:`);
        console.log(`[BATCH-SYNC]   Profile: hasProfile=${profile?.hasProfile}, score=${profile?.score}`);
        console.log(`[BATCH-SYNC]   Elements: ${JSON.stringify(profile?.elements)}`);
        console.log(`[BATCH-SYNC]   Primary address: ${profile?.primaryAddress}`);
        
        if (profile?.hasProfile && profile.score !== undefined) {
          // Apply same validation as individual sync
          const hasInteractions = (profile.elements?.totalReviews > 0) ||
            (profile.elements?.vouchCount > 0) ||
            profile.primaryAddress;
          
          const isDefaultProfile = profile.score === 1200 && !hasInteractions;
          
          console.log(`[BATCH-SYNC]   hasInteractions=${hasInteractions}, isDefaultProfile=${isDefaultProfile}`);
          
          if (hasInteractions && !isDefaultProfile) {
            // Has valid profile — use HV + validator data from batch profile results
            const hasValidator = (profile.validatorNftCount || 0) > 0;
            const isHumanVerified = profile.humanVerificationStatus === "VERIFIED";
            console.log(`[BATCH-SYNC]   hasValidator=${hasValidator}, isHumanVerified=${isHumanVerified}`);

            const scoreRoles = getExpectedRoles(profile.score, hasValidator, isHumanVerified, true);
            expectedRoles = scoreRoles; // This includes verified + verified profile + score role

            console.log(`[BATCH-SYNC]   Final expected roles: ${expectedRoles.map(id => getRoleNameFromId(id)).join(', ')}`);
          } else {
            console.log(`[BATCH-SYNC]   Profile invalid - keeping only basic verified role`);
          }
        } else {
          console.log(`[BATCH-SYNC]   No profile found - keeping only basic verified role`);
        }

        // Calculate role changes
        console.log(`[BATCH-SYNC]   Current Ethos roles: ${currentEthosRoles.map(id => getRoleNameFromId(id)).join(', ')}`);
        console.log(`[BATCH-SYNC]   Expected roles: ${expectedRoles.map(id => getRoleNameFromId(id)).join(', ')}`);
        
        const rolesToAdd = expectedRoles.filter(roleId => !currentRoles.includes(roleId));
        const rolesToRemove = currentEthosRoles.filter(roleId => !expectedRoles.includes(roleId));

        console.log(`[BATCH-SYNC]   Roles to add: ${rolesToAdd.map(id => getRoleNameFromId(id)).join(', ') || 'none'}`);
        console.log(`[BATCH-SYNC]   Roles to remove: ${rolesToRemove.map(id => getRoleNameFromId(id)).join(', ') || 'none'}`);

        if (rolesToAdd.length === 0 && rolesToRemove.length === 0) {
          // Mark as synced since roles are correct
          console.log(`[BATCH-SYNC]   No changes needed for user ${userId}`);
          await markUserSynced(userId);
          continue;
        }

        // Apply role changes
        const userChanges: string[] = [];

        // Remove incorrect roles
        for (const roleId of rolesToRemove) {
          const removeUrl = `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`;
          const removeResponse = await discordApiCall(removeUrl, { method: "DELETE" });

          if (removeResponse.ok) {
            const roleName = getRoleNameFromId(roleId);
            userChanges.push(`Removed ${roleName} role`);
          }

          await new Promise(resolve => setTimeout(resolve, SYNC_CONFIG.DELAY_BETWEEN_ROLE_OPS));
        }

        // Add correct roles
        for (const roleId of rolesToAdd) {
          const addUrl = `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`;
          const addResponse = await discordApiCall(addUrl, { method: "PUT" });

          if (addResponse.ok) {
            const roleName = getRoleNameFromId(roleId);
            userChanges.push(`Added ${roleName} role`);
          }

          await new Promise(resolve => setTimeout(resolve, SYNC_CONFIG.DELAY_BETWEEN_ROLE_OPS));
        }

        if (userChanges.length > 0) {
          changes.set(userId, userChanges);
          
          // Send webhook notification for batch sync changes
          await sendRoleChangeWebhook(userId, userChanges, "batch-sync", {
            userScore: profile?.score,
            profileInfo: profile?.hasProfile 
              ? `Profile found - ${profile.elements?.totalReviews || 0} reviews, ${profile.elements?.vouchCount || 0} vouches`
              : "No valid profile",
            guildId: guildId,
            processedCount: processedCount,
            totalCount: usersToSync.length,
          });
        }

        // Mark as synced
        await markUserSynced(userId);

        // Delay between users
        await new Promise(resolve => setTimeout(resolve, SYNC_CONFIG.DELAY_BETWEEN_USERS));

      } catch (error) {
        console.error(`[BATCH-SYNC] Error processing user ${userId}:`, error);
        errors.push(`Error processing user ${userId}: ${error.message}`);
      }
    }

    console.log(`[BATCH-SYNC] Completed batch sync. Changes: ${changes.size}, Errors: ${errors.length}`);
    
    // Send summary webhook notification for batch completion
    if (changes.size > 0) {
      const summaryChanges = [`✅ Batch sync completed: ${changes.size} users updated out of ${usersToSync.length} total`];
      if (errors.length > 0) {
        summaryChanges.push(`❌ ${errors.length} errors encountered`);
      }
      
      await sendRoleChangeWebhook("BATCH_SUMMARY", summaryChanges, "batch-sync", {
        profileInfo: `Processed ${usersToSync.length} users total`,
        guildId: guildId,
        totalCount: usersToSync.length,
      });
    }
    
    return { success: true, changes, errors };

  } catch (error) {
    console.error("[BATCH-SYNC] Error in batch sync:", error);
    return { success: false, changes: new Map(), errors: [error.message] };
  }
}
