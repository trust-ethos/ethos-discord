// Make this a module
export {};

const DISCORD_TOKEN = Deno.env.get("DISCORD_TOKEN");
const APPLICATION_ID = Deno.env.get("DISCORD_APPLICATION_ID");

if (!DISCORD_TOKEN || !APPLICATION_ID) {
  console.error("Missing required environment variables");
  Deno.exit(1);
}

// Function to list all global commands
async function listGlobalCommands() {
  const response = await fetch(
    `https://discord.com/api/v10/applications/${APPLICATION_ID}/commands`,
    {
      headers: {
        Authorization: `Bot ${DISCORD_TOKEN}`,
        "Content-Type": "application/json",
      }
    }
  );

  if (response.ok) {
    const commands = await response.json();
    console.log("Global commands:");
    commands.forEach((cmd: any) => {
      console.log(`- ${cmd.name} (ID: ${cmd.id})`);
    });
    return commands;
  } else {
    const error = await response.text();
    console.error("Failed to list global commands:", error);
    return [];
  }
}

// Function to list guild-specific commands
async function listGuildCommands(guildId: string) {
  const response = await fetch(
    `https://discord.com/api/v10/applications/${APPLICATION_ID}/guilds/${guildId}/commands`,
    {
      headers: {
        Authorization: `Bot ${DISCORD_TOKEN}`,
        "Content-Type": "application/json",
      }
    }
  );

  if (response.ok) {
    const commands = await response.json();
    console.log(`\nGuild commands for guild ${guildId}:`);
    commands.forEach((cmd: any) => {
      console.log(`- ${cmd.name} (ID: ${cmd.id})`);
    });
    return commands;
  } else {
    const error = await response.text();
    console.error(`Failed to list commands for guild ${guildId}:`, error);
    return [];
  }
}

// Function to delete all global commands
async function deleteGlobalCommands() {
  const commands = await listGlobalCommands();
  
  console.log("\nDeleting all global commands...");
  
  // Clear all global commands by sending an empty array
  const response = await fetch(
    `https://discord.com/api/v10/applications/${APPLICATION_ID}/commands`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bot ${DISCORD_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([])
    }
  );

  if (response.ok) {
    console.log("All global commands have been deleted successfully!");
  } else {
    const error = await response.text();
    console.error("Failed to delete global commands:", error);
  }
}

// Function to delete all guild commands
async function deleteGuildCommands(guildId: string) {
  const commands = await listGuildCommands(guildId);
  
  console.log(`\nDeleting all commands for guild ${guildId}...`);
  
  // Clear all guild commands by sending an empty array
  const response = await fetch(
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

  if (response.ok) {
    console.log(`All commands for guild ${guildId} have been deleted successfully!`);
  } else {
    const error = await response.text();
    console.error(`Failed to delete commands for guild ${guildId}:`, error);
  }
}

// Main function
async function main() {
  // First, list all commands to see what we have
  await listGlobalCommands();
  
  // Ask for a guild ID to list/delete guild commands
  console.log("\nEnter a guild ID to list/delete guild commands (leave empty to skip):");
  const guildId = prompt("Guild ID:");
  
  if (guildId) {
    await listGuildCommands(guildId);
  }
  
  // Ask for confirmation before deleting
  console.log("\nWhat would you like to do?");
  console.log("1. Delete all global commands");
  console.log("2. Delete all guild commands (for the entered guild ID)");
  console.log("3. Delete both global and guild commands");
  console.log("4. Exit without deleting");
  
  const action = prompt("Enter your choice (1-4):");
  
  switch (action) {
    case "1":
      await deleteGlobalCommands();
      break;
    case "2":
      if (guildId) {
        await deleteGuildCommands(guildId);
      } else {
        console.error("No guild ID provided. Cannot delete guild commands.");
      }
      break;
    case "3":
      await deleteGlobalCommands();
      if (guildId) {
        await deleteGuildCommands(guildId);
      } else {
        console.error("No guild ID provided. Cannot delete guild commands.");
      }
      break;
    case "4":
      console.log("Exiting without deleting any commands.");
      break;
    default:
      console.error("Invalid choice. Exiting without deleting any commands.");
  }
}

// Run the main function
main(); 