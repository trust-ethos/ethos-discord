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
// Hardcoded role IDs
const ETHOS_VERIFIED_ROLE_ID = "1330927513056186501"; // "verified" role (Discord connected)
const ETHOS_VERIFIED_PROFILE_ROLE_ID = "1367923031040721046"; // "Verified ethos profile" role (active profile)
// Score-based role IDs (regular)
const ETHOS_ROLE_EXEMPLARY = Deno.env.get("ETHOS_ROLE_EXEMPLARY") ||
  "1253205892917231677"; // Score >= 2000
const ETHOS_ROLE_REPUTABLE = Deno.env.get("ETHOS_ROLE_REPUTABLE") ||
  "1253206005169258537"; // Score >= 1600
const ETHOS_ROLE_NEUTRAL = Deno.env.get("ETHOS_ROLE_NEUTRAL") ||
  "1253206143182831637"; // Score >= 1200
const ETHOS_ROLE_QUESTIONABLE = Deno.env.get("ETHOS_ROLE_QUESTIONABLE") ||
  "1253206252306305024"; // Score >= 800
const ETHOS_ROLE_UNTRUSTED = Deno.env.get("ETHOS_ROLE_UNTRUSTED") ||
  "1253206385877975043"; // Score < 800

// Validator score-based role IDs
const ETHOS_VALIDATOR_EXEMPLARY = "1377685521723293706"; // Score >= 2000 + validator
const ETHOS_VALIDATOR_REPUTABLE = "1377477396759842936"; // Score >= 1600 + validator
const ETHOS_VALIDATOR_NEUTRAL = "1377685710026571876"; // Score >= 1200 + validator
const ETHOS_VALIDATOR_QUESTIONABLE = "1377688531522158632"; // Score >= 800 + validator
// No untrusted validator role - untrusted users get regular untrusted role even if they have validator

if (!PUBLIC_KEY || !APPLICATION_ID) {
  console.error("Environment variables check failed:");
  console.error("DISCORD_PUBLIC_KEY:", PUBLIC_KEY ? "set" : "missing");
  console.error("DISCORD_APPLICATION_ID:", APPLICATION_ID ? "set" : "missing");
  // Don't throw, just log the error
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
  const DISCORD_TOKEN_VAL = Deno.env.get("DISCORD_TOKEN");
  if (!DISCORD_TOKEN_VAL) {
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
    "Authorization": `Bot ${DISCORD_TOKEN_VAL}`,
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
        fetch(`https://api.ethos.network/api/v1/score/${userkey}`),
        fetch(`https://api.ethos.network/api/v1/users/${userkey}/stats`),
        fetch(`https://api.ethos.network/api/v1/activities/unified`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            target: userkey,
            direction: "subject",
            orderBy: {
              field: "votes",
              direction: "desc",
            },
            filter: ["review"],
            excludeHistorical: true,
            pagination: {
              offsets: {},
              limit: 1,
            },
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

    const topReviewData = topReviewResponseData.ok &&
      topReviewResponseData.data?.values?.[0]?.data;

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
          upvotes: topReviewResponseData.data.values[0].votes.upvotes,
          authorName: topReviewResponseData.data.values[0].author.name,
        }
        : null,
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
    const [profileResponse, userStatsResponse, topReviewResponse] =
      await Promise.all([
        fetch(`https://api.ethos.network/api/v1/score/${userkey}`),
        fetch(`https://api.ethos.network/api/v1/users/${userkey}/stats`),
        fetch(`https://api.ethos.network/api/v1/activities/unified`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            target: userkey,
            direction: "subject",
            orderBy: {
              field: "votes",
              direction: "desc",
            },
            filter: ["review"],
            excludeHistorical: true,
            pagination: {
              offsets: {},
              limit: 1,
            },
          }),
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

    const topReviewResponseData = await topReviewResponse.json();
    console.log(
      "Top Review Response:",
      JSON.stringify(topReviewResponseData, null, 2),
    );

    const topReviewData = topReviewResponseData.ok &&
      topReviewResponseData.data?.values?.[0]?.data;

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

    const scoreData = profileData.data;
    const elements = scoreData.elements || {};

    return {
      score: scoreData.score,
      handle: formattedHandle,
      twitterId,
      avatar: twitterData.data.avatar,
      name: twitterData.data.name,
      service: "twitter",
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
          upvotes: topReviewResponseData.data.values[0].votes.upvotes,
          authorName: topReviewResponseData.data.values[0].author.name,
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

// Function to get role ID based on score (regular roles)
function getRoleIdForScore(score: number): string {
  if (score >= 2000) return ETHOS_ROLE_EXEMPLARY;
  if (score >= 1600) return ETHOS_ROLE_REPUTABLE;
  if (score >= 1200) return ETHOS_ROLE_NEUTRAL;
  if (score >= 800) return ETHOS_ROLE_QUESTIONABLE;
  return ETHOS_ROLE_UNTRUSTED;
}

// Function to get validator role ID based on score
function getValidatorRoleIdForScore(score: number): string | null {
  if (score >= 2000) return ETHOS_VALIDATOR_EXEMPLARY;
  if (score >= 1600) return ETHOS_VALIDATOR_REPUTABLE;
  if (score >= 1200) return ETHOS_VALIDATOR_NEUTRAL;
  if (score >= 800) return ETHOS_VALIDATOR_QUESTIONABLE;
  return null; // No validator role for untrusted - they get regular untrusted role
}

// Function to get role name based on score
function getRoleNameForScore(score: number): string {
  if (score >= 2000) return "Exemplary";
  if (score >= 1600) return "Reputable";
  if (score >= 1200) return "Neutral";
  if (score >= 800) return "Questionable";
  return "Untrusted";
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

      // Handle ethos_verify command (verify user and assign role)
      if (commandName === "ethos_verify") {
        // Get the user's ID directly from the interaction
        const userId = interaction.member?.user?.id;
        const guildId = interaction.guild_id;

        if (!userId) {
          return {
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
              content:
                "Unable to identify your Discord account. Please try again.",
              flags: 64, // Ephemeral message (only visible to the user)
            },
          };
        }

        if (!guildId) {
          return {
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
              content: "This command can only be used in a server.",
              flags: 64, // Ephemeral message
            },
          };
        }

        // Immediately respond with "thinking" to prevent timeout
        // This gives us up to 15 minutes to complete the operation
        const deferredResponse = {
          type: InteractionResponseType.DeferredChannelMessageWithSource,
          data: {
            flags: 64, // Ephemeral message
          },
        };

        // Perform the verification asynchronously and send follow-up
        (async () => {
          try {
            // Clear cache for manual verification to ensure fresh check
            await clearUserCache(userId);

            // Use the optimized verification logic (always forces sync, bypasses cache)
            const verifyResult = await verifyUserRoles(guildId, userId);

            let followUpContent: string;

            if (!verifyResult.success) {
              // Check if it's a profile validation error
              if (verifyResult.profile && "error" in verifyResult.profile) {
                followUpContent = verifyResult.profile.error;
              } else {
                followUpContent =
                  "You don't have an Ethos profile OR you haven't connected Discord to your Ethos account yet. Ethos users can connect their Discord account at https://app.ethos.network/profile/settings?tab=social";
              }
            } else {
              const profile = verifyResult.profile;
              const ownsValidator = await checkUserOwnsValidator(userId);
              const scoreName = getRoleNameForScore(profile.score);

              // Create response message based on changes made
              followUpContent = "✅ Verification successful! ";

              if (verifyResult.changes.length > 0) {
                followUpContent += `Role changes: ${
                  verifyResult.changes.join(", ")
                }. `;
              } else {
                followUpContent += "Your roles were already up to date. ";
              }

              // Show the appropriate role information
              if (ownsValidator) {
                const validatorRoleId = getValidatorRoleIdForScore(profile.score);
                if (validatorRoleId) {
                  const validatorRoleName = getRoleNameFromId(validatorRoleId);
                  followUpContent +=
                    `You have a ${scoreName} score of ${profile.score} and the ${validatorRoleName} role.`;
                } else {
                  // Untrusted users get regular untrusted role even with validator
                  followUpContent +=
                    `You have a ${scoreName} score of ${profile.score}. Note: Untrusted users receive the regular Untrusted role even with a validator NFT.`;
                }
              } else {
                followUpContent +=
                  `You have a ${scoreName} score of ${profile.score}.`;
              }
            }

            // Send follow-up message with the result
            await safeFollowUp(interaction, followUpContent);

          } catch (error) {
            console.error("Error in async ethos_verify:", error);
            
            // Send error follow-up message
            const errorMessage = "❌ An error occurred while verifying your profile. Please try again later.";
            try {
              await safeFollowUp(interaction, errorMessage);
            } catch (followUpError) {
              console.error("Error sending follow-up message:", followUpError);
            }
          }
        })();

        return deferredResponse;
      } // Handle ethos command (Discord profiles)
      else if (commandName === "ethos") {
        // With a User type option, Discord will automatically provide the user ID
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
            // No flags = public message
          },
        };

        // Process asynchronously and send follow-up
        (async () => {
          try {
            console.log("Discord user ID from interaction:", userId);

            // Get the Discord user information
            const userData = interaction.data.resolved?.users?.[userId];
            const username = userData?.username || "Unknown User";
            // Use display name (global_name) if available, otherwise use username
            const displayName = userData?.global_name || username;

            console.log("Discord username:", username);
            console.log("Discord display name:", displayName);

            // Get user's Discord avatar URL if available
            let avatarUrl: string | undefined = undefined;
            if (userData?.avatar) {
              // Discord avatar format: https://cdn.discordapp.com/avatars/{user.id}/{user.avatar}.png
              avatarUrl =
                `https://cdn.discordapp.com/avatars/${userId}/${userData.avatar}.png`;
            }

            const profile = await fetchEthosProfileByDiscord(userId, avatarUrl);

            if ("error" in profile) {
              await sendFollowUpMessage(interaction.id, interaction.token, profile.error);
              return;
            }

            // Display the display name in the title
            const title = `Ethos profile for ${displayName}`;

            // Use the primary address for the profile URL if available, otherwise fall back to Discord
            let profileUrl;
            if (profile.primaryAddress) {
              profileUrl =
                `https://app.ethos.network/profile/${profile.primaryAddress}?src=discord-agent`;
            } else {
              profileUrl =
                `https://app.ethos.network/profile/discord/${profile.userId}?src=discord-agent`;
            }

            // Send follow-up with embed (public)
            await sendPublicFollowUpEmbedMessage(interaction.id, interaction.token, {
              title,
              url: profileUrl,
              description: `${displayName} is considered **${
                getScoreLabel(profile.score)
              }**.`,
              color: getScoreColor(profile.score),
              thumbnail: {
                // Use Discord avatar if available, otherwise use Ethos avatar or default
                url: avatarUrl || profile.avatar ||
                  "https://cdn.discordapp.com/embed/avatars/0.png",
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
            console.error("Error in async ethos command:", error);
            
            try {
              await sendFollowUpMessage(interaction.id, interaction.token, 
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
            // No flags = public message
          },
        };

        // Process asynchronously and send follow-up
        (async () => {
          try {
            const profile = await fetchEthosProfileByTwitter(twitterHandle);

            if ("error" in profile) {
              await sendFollowUpMessage(interaction.id, interaction.token, profile.error);
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
              await sendFollowUpMessage(interaction.id, interaction.token, 
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

function getScoreLabel(score: number): string {
  if (score >= 2000) return "exemplary";
  if (score >= 1600) return "reputable";
  if (score >= 1200) return "neutral";
  if (score >= 800) return "questionable";
  return "untrusted";
}

function getScoreColor(score: number): number {
  if (score >= 2000) return 0x127F31; // Exemplary - Green
  if (score >= 1600) return 0x2E7BC3; // Reputable - Blue
  if (score >= 1200) return 0xC1C0B6; // Neutral - Gray
  if (score >= 800) return 0xCC9A1A; // Questionable - Yellow
  return 0xB72B38; // Untrusted - Red
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

// Function to get current Ethos roles for a user
function getCurrentEthosRoles(userRoles: string[]): string[] {
  const ethosRoles = [
    ETHOS_VERIFIED_ROLE_ID,
    ETHOS_VERIFIED_PROFILE_ROLE_ID,
    ETHOS_VALIDATOR_EXEMPLARY,
    ETHOS_VALIDATOR_REPUTABLE,
    ETHOS_VALIDATOR_NEUTRAL,
    ETHOS_VALIDATOR_QUESTIONABLE,
    ETHOS_ROLE_EXEMPLARY,
    ETHOS_ROLE_REPUTABLE,
    ETHOS_ROLE_NEUTRAL,
    ETHOS_ROLE_QUESTIONABLE,
    ETHOS_ROLE_UNTRUSTED,
  ];

  return userRoles.filter((roleId) => ethosRoles.includes(roleId));
}

// Function to get expected roles based on Ethos profile
function getExpectedRoles(
  score: number,
  hasValidator: boolean,
  hasValidProfile: boolean,
): string[] {
  const expectedRoles = [ETHOS_VERIFIED_ROLE_ID]; // Always has basic verified role

  // Add verified profile role if they have a valid profile
  if (hasValidProfile) {
    expectedRoles.push(ETHOS_VERIFIED_PROFILE_ROLE_ID);
  }

  // Add score-based role only if they have a valid profile
  if (hasValidProfile) {
    if (hasValidator) {
      // If they have a validator, give them the validator version of their score role
      const validatorRoleId = getValidatorRoleIdForScore(score);
      if (validatorRoleId) {
        expectedRoles.push(validatorRoleId);
      } else {
        // Untrusted users get regular untrusted role even with validator
        expectedRoles.push(getRoleIdForScore(score));
      }
    } else {
      // No validator, give them regular score role
      expectedRoles.push(getRoleIdForScore(score));
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

    // Check validator status
    const hasValidator = await checkUserOwnsValidator(userId);

    // Get expected roles
    const expectedRoles = getExpectedRoles(profile.score, hasValidator, true);

    // Compare current vs expected roles
    const rolesToAdd = expectedRoles.filter((roleId) =>
      !currentRoles.includes(roleId)
    );
    const rolesToRemove = currentEthosRoles.filter((roleId) =>
      !expectedRoles.includes(roleId)
    );

    // Early exit if no changes needed
    if (rolesToAdd.length === 0 && rolesToRemove.length === 0) {
      console.log(
        `${progressPrefix}[${operationType}] User ${userId} already has correct roles, no changes needed`,
      );
      // Mark as synced since roles are correct
      await markUserSynced(userId);
      return { success: true, changes: [] };
    }

    const changes: string[] = [];

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
  switch (roleId) {
    case ETHOS_VERIFIED_ROLE_ID:
      return "Verified";
    case ETHOS_VERIFIED_PROFILE_ROLE_ID:
      return "Verified Profile";
    case ETHOS_VALIDATOR_EXEMPLARY:
      return "Exemplary Validator";
    case ETHOS_VALIDATOR_REPUTABLE:
      return "Reputable Validator";
    case ETHOS_VALIDATOR_NEUTRAL:
      return "Neutral Validator";
    case ETHOS_VALIDATOR_QUESTIONABLE:
      return "Questionable Validator";
    case ETHOS_ROLE_EXEMPLARY:
      return "Exemplary";
    case ETHOS_ROLE_REPUTABLE:
      return "Reputable";
    case ETHOS_ROLE_NEUTRAL:
      return "Neutral";
    case ETHOS_ROLE_QUESTIONABLE:
      return "Questionable";
    case ETHOS_ROLE_UNTRUSTED:
      return "Untrusted";
    default:
      return "Unknown";
  }
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
function getAllValidatorRoles(): string[] {
  return [
    ETHOS_VALIDATOR_EXEMPLARY,
    ETHOS_VALIDATOR_REPUTABLE,
    ETHOS_VALIDATOR_NEUTRAL,
    ETHOS_VALIDATOR_QUESTIONABLE,
  ];
}

// Function to get equivalent regular role for a validator role
function getRegularRoleForValidator(validatorRoleId: string): string {
  switch (validatorRoleId) {
    case ETHOS_VALIDATOR_EXEMPLARY:
      return ETHOS_ROLE_EXEMPLARY;
    case ETHOS_VALIDATOR_REPUTABLE:
      return ETHOS_ROLE_REPUTABLE;
    case ETHOS_VALIDATOR_NEUTRAL:
      return ETHOS_ROLE_NEUTRAL;
    case ETHOS_VALIDATOR_QUESTIONABLE:
      return ETHOS_ROLE_QUESTIONABLE;
    default:
      return ETHOS_ROLE_UNTRUSTED; // Fallback
  }
}

// Function to get all users with validator roles
async function getUsersWithValidatorRoles(guildId: string): Promise<{userId: string, validatorRoles: string[]}[]> {
  try {
    console.log("[VALIDATOR-CHECK] Fetching users with validator roles from guild:", guildId);

    // Get all members from the guild
    const url = `https://discord.com/api/v10/guilds/${guildId}/members?limit=1000`;
    const response = await discordApiCall(url, { method: "GET" });

    if (!response.ok) {
      console.error(`[VALIDATOR-CHECK] Failed to fetch guild members: ${response.status}`);
      return [];
    }

    const members = await response.json();
    const validatorRoleIds = getAllValidatorRoles();
    const usersWithValidatorRoles: {userId: string, validatorRoles: string[]}[] = [];

    // Filter members who have any validator roles
    for (const member of members) {
      const memberValidatorRoles = member.roles.filter((roleId: string) => 
        validatorRoleIds.includes(roleId)
      );
      
      if (memberValidatorRoles.length > 0) {
        usersWithValidatorRoles.push({
          userId: member.user.id,
          validatorRoles: memberValidatorRoles
        });
      }
    }

    console.log(`[VALIDATOR-CHECK] Found ${usersWithValidatorRoles.length} users with validator roles`);
    return usersWithValidatorRoles;
  } catch (error) {
    console.error("[VALIDATOR-CHECK] Error fetching users with validator roles:", error);
    return [];
  }
}

// Function to verify and potentially demote a single user
async function verifyUserValidator(
  guildId: string, 
  userId: string, 
  validatorRoles: string[],
  userNumber?: number,
  totalUsers?: number
): Promise<{ success: boolean; changes: string[]; demoted: boolean }> {
  try {
    const progressPrefix = userNumber && totalUsers ? `[${userNumber}/${totalUsers}] ` : "";
    console.log(`${progressPrefix}[VALIDATOR-CHECK] Checking validator status for user: ${userId}`);

    // Check if user still owns a validator NFT
    const ownsValidator = await checkUserOwnsValidator(userId);

    if (ownsValidator) {
      console.log(`${progressPrefix}[VALIDATOR-CHECK] User ${userId} still owns validator, no changes needed`);
      return { success: true, changes: [], demoted: false };
    }

    console.log(`${progressPrefix}[VALIDATOR-CHECK] User ${userId} no longer owns validator, demoting from validator roles`);

    // User no longer owns validator, need to demote them
    const changes: string[] = [];

    // Get user's current Ethos profile to determine correct regular role
    const profile = await fetchEthosProfileByDiscord(userId);
    
    let targetRegularRole = ETHOS_ROLE_UNTRUSTED; // Default fallback
    
    if (!("error" in profile) && typeof profile.score === "number") {
      // User has valid profile, determine role by score
      targetRegularRole = getRoleIdForScore(profile.score);
    }

    // Remove all validator roles
    for (const validatorRoleId of validatorRoles) {
      const removeUrl = `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${validatorRoleId}`;
      const removeResponse = await discordApiCall(removeUrl, { method: "DELETE" });

      if (removeResponse.ok) {
        const roleName = getRoleNameFromId(validatorRoleId);
        changes.push(`Removed ${roleName} role`);
        console.log(`${progressPrefix}[VALIDATOR-CHECK] Removed validator role ${roleName} from user ${userId}`);
      } else {
        console.error(`${progressPrefix}[VALIDATOR-CHECK] Failed to remove validator role ${validatorRoleId} from user ${userId}: ${removeResponse.status}`);
      }

      // Delay between role operations
      await new Promise(resolve => setTimeout(resolve, VALIDATOR_CHECK_CONFIG.DELAY_BETWEEN_USERS / 4));
    }

    // Add the appropriate regular role
    const addUrl = `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${targetRegularRole}`;
    const addResponse = await discordApiCall(addUrl, { method: "PUT" });

    if (addResponse.ok) {
      const roleName = getRoleNameFromId(targetRegularRole);
      changes.push(`Added ${roleName} role`);
      console.log(`${progressPrefix}[VALIDATOR-CHECK] Added regular role ${roleName} to user ${userId}`);
    } else {
      console.error(`${progressPrefix}[VALIDATOR-CHECK] Failed to add regular role ${targetRegularRole} to user ${userId}: ${addResponse.status}`);
    }

    return { success: true, changes, demoted: true };

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

// ===== AUTOMATED CRON-BASED OPERATIONS =====

// Set up automated validator verification and batch sync using Deno.cron
// This only runs in production deployments on Deno Deploy
const ENABLE_AUTO_VALIDATOR_CHECK = Deno.env.get("ENABLE_AUTO_VALIDATOR_CHECK") === "true";
const ENABLE_AUTO_BATCH_SYNC = Deno.env.get("ENABLE_AUTO_BATCH_SYNC") === "true";

// Validator verification cron (every 2 hours)
if (ENABLE_AUTO_VALIDATOR_CHECK) {
  console.log("🕐 Setting up automated validator verification with Deno.cron (every 2 hours)");
  
  Deno.cron("Validator Verification", "0 */2 * * *", {
    backoffSchedule: [1000, 5000, 10000], // Retry after 1s, 5s, 10s if failed
  }, async () => {
    console.log("🔍 [CRON] Starting automated validator verification");
    
    try {
      const guildId = Deno.env.get("DISCORD_GUILD_ID");
      if (!guildId) {
        console.error("[CRON] DISCORD_GUILD_ID environment variable not set for validator cron job");
        return;
      }
      
      await performValidatorVerification(guildId);
      console.log("✅ [CRON] Automated validator verification completed successfully");
    } catch (error) {
      console.error("❌ [CRON] Error in automated validator verification:", error);
      throw error; // This will trigger the retry mechanism
    }
  });
  
  console.log("✅ Automated validator verification is enabled (every 2 hours)");
} else {
  console.log("ℹ️ Automated validator verification is disabled (set ENABLE_AUTO_VALIDATOR_CHECK=true to enable)");
}

// Batch sync cron (every 6 hours)
if (ENABLE_AUTO_BATCH_SYNC) {
  console.log("🕐 Setting up automated batch sync with Deno.cron (every 6 hours)");
  
  Deno.cron("Batch Role Sync", "0 */6 * * *", {
    backoffSchedule: [5000, 15000, 30000], // Longer backoff for batch operations
  }, async () => {
    console.log("🔄 [CRON] Starting automated batch role sync");
    
    try {
      const guildId = Deno.env.get("DISCORD_GUILD_ID");
      if (!guildId) {
        console.error("[CRON] DISCORD_GUILD_ID environment variable not set for batch sync cron job");
        return;
      }
      
      // Get all verified members
      const verifiedMembers = await getVerifiedMembers(guildId);
      console.log(`[CRON] Found ${verifiedMembers.length} verified members for batch sync`);
      
      if (verifiedMembers.length === 0) {
        console.log("[CRON] No verified members found for batch sync");
        return;
      }

      // Use batch sync function (optimized with batch APIs)
      const result = await syncUserRolesBatch(guildId, verifiedMembers, false);
      
      console.log(`[CRON] Batch sync completed. Changes: ${result.changes.size}, Errors: ${result.errors.length}`);
      
      // Log summary
      let totalChanges = 0;
      for (const [userId, userChanges] of result.changes) {
        totalChanges += userChanges.length;
        if (userChanges.length > 0) {
          console.log(`[CRON] User ${userId}: ${userChanges.join(", ")}`);
        }
      }
      
      if (result.errors.length > 0) {
        console.log(`[CRON] Errors: ${result.errors.slice(0, 5).join("; ")}${result.errors.length > 5 ? ` (and ${result.errors.length - 5} more)` : ""}`);
      }
      
      console.log(`✅ [CRON] Automated batch sync complete: ${result.changes.size} users changed, ${totalChanges} total changes`);
      
    } catch (error) {
      console.error("❌ [CRON] Error in automated batch sync:", error);
      throw error; // This will trigger the retry mechanism
    }
  });
  
  console.log("✅ Automated batch sync is enabled (every 6 hours)");
} else {
  console.log("ℹ️ Automated batch sync is disabled (set ENABLE_AUTO_BATCH_SYNC=true to enable)");
}

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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userkeys })
      }),
      fetch(`https://api.ethos.network/api/v2/users/by/discord`, {
        method: "POST", 
        headers: { "Content-Type": "application/json" },
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
            
            results.set(userId, {
              ...existing,
              elements: {
                totalReviews,
                vouchCount,
                positivePercentage,
              },
              primaryAddress: hasEthAddress ? "detected" : undefined
            });
            
            usersWithStats.add(userId);
            console.log(`[BATCH] User ${userId}: reviews=${totalReviews}, vouches=${vouchCount}, address=${hasEthAddress ? 'yes' : 'no'}`);
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
            fetch(`https://api.ethos.network/api/v1/score/${userkey}`),
            fetch(`https://api.ethos.network/api/v1/users/${userkey}/stats`)
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

    // Batch fetch validator status for users with valid profiles
    // FIX: Include users with score 0 and any hasProfile flag
    const usersWithProfiles = Array.from(allProfileData.entries())
      .filter(([_, profile]) => profile.hasProfile && profile.score !== undefined)
      .map(([userId]) => userId);

    console.log(`[BATCH-SYNC] Profile data summary:`);
    for (const [userId, profile] of allProfileData.entries()) {
      console.log(`[BATCH-SYNC] User ${userId}: hasProfile=${profile.hasProfile}, score=${profile.score}, elements=${JSON.stringify(profile.elements)}`);
    }

    const validatorStatuses = new Map<string, boolean>();
    if (usersWithProfiles.length > 0) {
      console.log(`[BATCH-SYNC] Checking validator status for ${usersWithProfiles.length} users with profiles`);
      
      // Check validators in smaller batches to avoid overwhelming the API
      const validatorBatchSize = 50;
      for (let i = 0; i < usersWithProfiles.length; i += validatorBatchSize) {
        const batch = usersWithProfiles.slice(i, i + validatorBatchSize);
        
        // Check each user's validator status
        const batchPromises = batch.map(async (userId) => {
          const hasValidator = await checkUserOwnsValidator(userId);
          console.log(`[BATCH-SYNC] User ${userId} validator check: ${hasValidator}`);
          return [userId, hasValidator] as [string, boolean];
        });
        
        const batchResults = await Promise.all(batchPromises);
        for (const [userId, hasValidator] of batchResults) {
          validatorStatuses.set(userId, hasValidator);
        }
        
        // Delay between validator batches
        if (i + validatorBatchSize < usersWithProfiles.length) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }

    // Now process role changes for each user
    const changes = new Map<string, string[]>();
    const errors: string[] = [];
    let processedCount = 0;

    for (const userId of usersToSync) {
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
            // Has valid profile
            expectedRoles.push(ETHOS_VERIFIED_PROFILE_ROLE_ID);
            
            const hasValidator = validatorStatuses.get(userId) || false;
            console.log(`[BATCH-SYNC]   hasValidator=${hasValidator}`);
            
            const scoreRoles = getExpectedRoles(profile.score, hasValidator, true);
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
    return { success: true, changes, errors };

  } catch (error) {
    console.error("[BATCH-SYNC] Error in batch sync:", error);
    return { success: false, changes: new Map(), errors: [error.message] };
  }
}
