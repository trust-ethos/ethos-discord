// Make this a module
export {};

const DISCORD_TOKEN = Deno.env.get("DISCORD_TOKEN");
const APPLICATION_ID = Deno.env.get("DISCORD_APPLICATION_ID");

if (!DISCORD_TOKEN || !APPLICATION_ID) {
  console.error("Missing required environment variables");
  Deno.exit(1);
}

console.log("Enter the ID of the guild/server to clear commands from:");
const guildId = prompt("Guild ID:");

if (!guildId) {
  console.error("No guild ID provided. Exiting.");
  Deno.exit(1);
}

async function clearGuildCommands(guildId: string) {
  console.log(`\nFetching commands for guild ${guildId}...`);
  
  // First, get the current commands
  const listResponse = await fetch(
    `https://discord.com/api/v10/applications/${APPLICATION_ID}/guilds/${guildId}/commands`,
    {
      headers: {
        Authorization: `Bot ${DISCORD_TOKEN}`,
        "Content-Type": "application/json",
      }
    }
  );
  
  if (!listResponse.ok) {
    console.error(`Error fetching commands: ${listResponse.status}`);
    console.error(await listResponse.text());
    return;
  }
  
  const commands = await listResponse.json();
  console.log(`Found ${commands.length} commands in guild ${guildId}:`);
  commands.forEach((cmd: any) => {
    console.log(`- /${cmd.name} (ID: ${cmd.id})`);
  });
  
  // Ask for confirmation
  console.log("\nDo you want to clear all commands in this guild? (y/n)");
  const confirm = prompt("Enter y to confirm:");
  
  if (confirm?.toLowerCase() !== "y") {
    console.log("Operation cancelled. No commands were cleared.");
    return;
  }
  
  // Clear all commands by sending an empty array
  const clearResponse = await fetch(
    `https://discord.com/api/v10/applications/${APPLICATION_ID}/guilds/${guildId}/commands`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bot ${DISCORD_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([])
    }
  );
  
  if (clearResponse.ok) {
    console.log(`Successfully cleared all commands in guild ${guildId}.`);
  } else {
    console.error(`Error clearing commands: ${clearResponse.status}`);
    console.error(await clearResponse.text());
  }
}

clearGuildCommands(guildId); 