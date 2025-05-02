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
    console.log("Current global commands:");
    commands.forEach((cmd: any) => {
      console.log(`- /${cmd.name} (ID: ${cmd.id})`);
    });
    return commands;
  } else {
    const error = await response.text();
    console.error("Failed to list global commands:", error);
    return [];
  }
}

// Function to clear all global commands
async function clearGlobalCommands() {
  console.log("\nClearing all global commands...");
  
  const response = await fetch(
    `https://discord.com/api/v10/applications/${APPLICATION_ID}/commands`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bot ${DISCORD_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([]) // Empty array to remove all commands
    }
  );

  if (response.ok) {
    console.log("All global commands have been cleared successfully!");
  } else {
    const error = await response.text();
    console.error("Failed to clear global commands:", error);
  }
}

// Main function
async function main() {
  console.log("Checking current commands...");
  
  // First list current commands
  await listGlobalCommands();
  
  // Ask for confirmation
  console.log("\nDo you want to clear all global commands? (y/n)");
  
  const confirm = prompt("Enter y to confirm:");
  
  if (confirm?.toLowerCase() === "y") {
    await clearGlobalCommands();
    
    console.log("\nTo register the commands again, run:");
    console.log("deno run --allow-net --allow-env register.ts");
  } else {
    console.log("No commands were cleared.");
  }
}

// Run the main function
main(); 