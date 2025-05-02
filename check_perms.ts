// Make this a module
export {};

// Get environment variables
const DISCORD_BOT_TOKEN = Deno.env.get("DISCORD_BOT_TOKEN");
const ETHOS_VERIFIED_ROLE_ID = Deno.env.get("ETHOS_VERIFIED_ROLE_ID");

// Check if required environment variables are set
if (!DISCORD_BOT_TOKEN) {
  console.error("Error: DISCORD_BOT_TOKEN environment variable is not set.");
  Deno.exit(1);
}

if (!ETHOS_VERIFIED_ROLE_ID) {
  console.error("Error: ETHOS_VERIFIED_ROLE_ID environment variable is not set.");
  Deno.exit(1);
}

console.log("Enter the ID of the guild/server to check permissions for:");
const guildId = prompt("Guild ID:");

if (!guildId) {
  console.error("No guild ID provided. Exiting.");
  Deno.exit(1);
}

// Function to check permissions
async function checkBotPermissions(guildId: string) {
  try {
    console.log(`Checking bot permissions in guild ${guildId}...`);
    
    // 1. First get the bot's own user info
    const botResponse = await fetch("https://discord.com/api/v10/users/@me", {
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`
      }
    });
    
    if (!botResponse.ok) {
      console.error(`Failed to get bot information: ${botResponse.status}`);
      console.error(await botResponse.text());
      return;
    }
    
    const botInfo = await botResponse.json();
    console.log(`Bot username: ${botInfo.username} (ID: ${botInfo.id})`);
    
    // 2. Check if the bot is in the guild
    const guildMemberResponse = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${botInfo.id}`, {
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`
      }
    });
    
    if (!guildMemberResponse.ok) {
      console.error(`Failed to get bot's guild membership: ${guildMemberResponse.status}`);
      console.error(await guildMemberResponse.text());
      return;
    }
    
    const guildMember = await guildMemberResponse.json();
    console.log(`Bot is a member of the guild with roles: ${guildMember.roles.join(", ")}`);
    
    // 3. Get guild roles
    const rolesResponse = await fetch(`https://discord.com/api/v10/guilds/${guildId}/roles`, {
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`
      }
    });
    
    if (!rolesResponse.ok) {
      console.error(`Failed to get guild roles: ${rolesResponse.status}`);
      console.error(await rolesResponse.text());
      return;
    }
    
    const roles = await rolesResponse.json();
    console.log("\nGuild roles:");
    
    // Find our target role
    const targetRole = roles.find((role: any) => role.id === ETHOS_VERIFIED_ROLE_ID);
    if (!targetRole) {
      console.error(`The role with ID ${ETHOS_VERIFIED_ROLE_ID} does not exist in this guild.`);
      return;
    }
    
    console.log(`Target role: ${targetRole.name} (ID: ${targetRole.id}), Position: ${targetRole.position}`);
    
    // Get the bot's highest role position
    const botRoles = roles.filter((role: any) => guildMember.roles.includes(role.id));
    const botHighestRole = botRoles.reduce((highest: any, role: any) => {
      return role.position > highest.position ? role : highest;
    }, { position: -1 });
    
    console.log(`Bot's highest role: ${botHighestRole.name || "None"} (Position: ${botHighestRole.position})`);
    
    // Check if bot has MANAGE_ROLES permission
    // Permission code for MANAGE_ROLES is 1 << 28 = 268435456
    const hasManageRoles = (guildMember.permissions & 268435456) === 268435456;
    console.log(`Bot has MANAGE_ROLES permission: ${hasManageRoles ? "Yes" : "No"}`);
    
    // Check if bot's role is higher than the target role
    const hasHigherRole = botHighestRole.position > targetRole.position;
    console.log(`Bot's highest role is higher than target role: ${hasHigherRole ? "Yes" : "No"}`);
    
    if (!hasManageRoles) {
      console.error("\nERROR: Bot does not have the 'Manage Roles' permission.");
      console.log("Solution: Go to Server Settings -> Roles -> Select the bot's role -> Enable 'Manage Roles'");
    }
    
    if (!hasHigherRole) {
      console.error("\nERROR: Bot's highest role is not higher than the target role in the hierarchy.");
      console.log("Solution: Go to Server Settings -> Roles and move the bot's role above the target role");
    }
    
    if (hasManageRoles && hasHigherRole) {
      console.log("\n✅ The bot has all necessary permissions to assign the target role!");
    } else {
      console.log("\n❌ The bot is missing required permissions or role hierarchy position.");
    }
    
  } catch (error) {
    console.error("Error checking permissions:", error);
  }
}

// Run the permission check
checkBotPermissions(guildId); 