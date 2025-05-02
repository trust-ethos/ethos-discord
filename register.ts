// Make this a module
export {};

const DISCORD_TOKEN = Deno.env.get("DISCORD_TOKEN");
const APPLICATION_ID = Deno.env.get("DISCORD_APPLICATION_ID");

if (!DISCORD_TOKEN || !APPLICATION_ID) {
  console.error("Missing required environment variables");
  Deno.exit(1);
}

// Register the slash command
const command = {
  name: "ethos",
  description: "Look up Ethos profile for a user",
  type: 1, // ChatInput
  options: [{
    type: 3, // String
    name: "handle",
    description: "Twitter handle or Discord username to look up (with or without @ for Twitter)",
    required: true
  }]
};

console.log("Registering slash command...");

const response = await fetch(
  `https://discord.com/api/v10/applications/${APPLICATION_ID}/commands`,
  {
    method: "POST",
    headers: {
      Authorization: `Bot ${DISCORD_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  }
);

if (response.ok) {
  console.log("Slash command registered successfully!");
} else {
  const error = await response.text();
  console.error("Failed to register slash command:", error);
  Deno.exit(1);
} 