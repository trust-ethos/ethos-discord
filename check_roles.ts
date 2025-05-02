// Make this a module
export {};

// Get environment variables
const DISCORD_TOKEN = Deno.env.get("DISCORD_TOKEN");
const ETHOS_VERIFIED_ROLE_ID = Deno.env.get("ETHOS_VERIFIED_ROLE_ID");
const ETHOS_ROLE_EXEMPLARY = Deno.env.get("ETHOS_ROLE_EXEMPLARY");
const ETHOS_ROLE_REPUTABLE = Deno.env.get("ETHOS_ROLE_REPUTABLE");
const ETHOS_ROLE_NEUTRAL = Deno.env.get("ETHOS_ROLE_NEUTRAL");
const ETHOS_ROLE_QUESTIONABLE = Deno.env.get("ETHOS_ROLE_QUESTIONABLE");
const ETHOS_ROLE_UNTRUSTED = Deno.env.get("ETHOS_ROLE_UNTRUSTED");

console.log("Checking configured role IDs...");
console.log("=============================");
console.log(`DISCORD_TOKEN: ${DISCORD_TOKEN ? "✅ Set" : "❌ NOT SET"}`);
console.log(`ETHOS_VERIFIED_ROLE_ID: ${ETHOS_VERIFIED_ROLE_ID || "❌ NOT SET"}`);
console.log(`ETHOS_ROLE_EXEMPLARY: ${ETHOS_ROLE_EXEMPLARY || "❌ NOT SET"}`);
console.log(`ETHOS_ROLE_REPUTABLE: ${ETHOS_ROLE_REPUTABLE || "❌ NOT SET"}`);
console.log(`ETHOS_ROLE_NEUTRAL: ${ETHOS_ROLE_NEUTRAL || "❌ NOT SET"}`);
console.log(`ETHOS_ROLE_QUESTIONABLE: ${ETHOS_ROLE_QUESTIONABLE || "❌ NOT SET"}`);
console.log(`ETHOS_ROLE_UNTRUSTED: ${ETHOS_ROLE_UNTRUSTED || "❌ NOT SET"}`);
console.log("=============================");

// If we have a Discord token, let's check if we can fetch the role info
if (DISCORD_TOKEN) {
  console.log("\nTesting Discord API access...");
  
  // Ask for a guild ID
  console.log("Enter your Discord server/guild ID to check roles (or press Enter to skip):");
  const guildId = prompt("Guild ID:");
  
  if (guildId) {
    fetchGuildRoles(guildId);
  } else {
    console.log("Guild ID not provided. Skipping role check.");
  }
}

// Function to fetch the roles in a guild
async function fetchGuildRoles(guildId: string) {
  try {
    console.log(`\nFetching roles for guild ${guildId}...`);
    
    const response = await fetch(`https://discord.com/api/v10/guilds/${guildId}/roles`, {
      headers: {
        Authorization: `Bot ${DISCORD_TOKEN}`
      }
    });
    
    if (!response.ok) {
      console.error(`Error fetching roles: ${response.status} ${response.statusText}`);
      console.error(await response.text());
      return;
    }
    
    const roles = await response.json();
    
    console.log(`\nFound ${roles.length} roles in the server:`);
    roles.forEach((role: any) => {
      console.log(`- ${role.name} (ID: ${role.id})`);
    });
    
    // Check if our configured roles exist in the server
    console.log("\nChecking if configured roles exist in the server:");
    
    checkRole(roles, "Verified", ETHOS_VERIFIED_ROLE_ID);
    checkRole(roles, "Exemplary", ETHOS_ROLE_EXEMPLARY);
    checkRole(roles, "Reputable", ETHOS_ROLE_REPUTABLE);
    checkRole(roles, "Neutral", ETHOS_ROLE_NEUTRAL);
    checkRole(roles, "Questionable", ETHOS_ROLE_QUESTIONABLE);
    checkRole(roles, "Untrusted", ETHOS_ROLE_UNTRUSTED);
    
  } catch (error) {
    console.error("Error fetching roles:", error);
  }
}

// Function to check if a configured role exists
function checkRole(roles: any[], roleName: string, roleId: string | null | undefined) {
  if (!roleId) {
    console.log(`❌ ${roleName} role ID not configured`);
    return;
  }
  
  const role = roles.find((r: any) => r.id === roleId);
  if (role) {
    console.log(`✅ ${roleName} role found: ${role.name} (${roleId})`);
  } else {
    console.log(`❌ ${roleName} role not found in server! Configured ID: ${roleId}`);
  }
} 