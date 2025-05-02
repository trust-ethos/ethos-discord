// Make this a module
export {};

const DISCORD_TOKEN = Deno.env.get("DISCORD_TOKEN");
const APPLICATION_ID = Deno.env.get("DISCORD_APPLICATION_ID");

if (!DISCORD_TOKEN || !APPLICATION_ID) {
  console.error("Missing required environment variables");
  Deno.exit(1);
}

// Register the slash commands
const commands = [
  {
    name: "ethos",
    description: "Look up Ethos profile for a Discord user",
    type: 1, // ChatInput
    options: [{
      type: 6, // USER (Discord user mention)
      name: "user",
      description: "Discord user to look up",
      required: true
    }]
  },
  {
    name: "ethosx",
    description: "Look up Ethos profile for a Twitter user",
    type: 1, // ChatInput
    options: [{
      type: 3, // String
      name: "twitter_handle",
      description: "Twitter handle to look up (with or without @)",
      required: true
    }]
  },
  {
    name: "ethos_verify",
    description: "Verify and assign a role if you have an Ethos profile",
    type: 1, // ChatInput
    options: [] // No options needed as it will use the user's own Discord ID
  }
];

console.log("Registering global slash commands...");

// Use global command registration endpoint
const endpoint = `https://discord.com/api/v10/applications/${APPLICATION_ID}/commands`;

console.log(`Registering to endpoint: ${endpoint}`);

const response = await fetch(
  endpoint,
  {
    method: "PUT", // Use PUT to replace all commands
    headers: {
      Authorization: `Bot ${DISCORD_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  }
);

if (response.ok) {
  console.log("Slash commands registered successfully!");
  const responseData = await response.json();
  console.log(`Registered ${responseData.length} commands:`);
  responseData.forEach((cmd: any) => {
    console.log(`- /${cmd.name}`);
  });
} else {
  const error = await response.text();
  console.error("Failed to register slash commands:", error);
  Deno.exit(1);
} 