import {
  Client,
  Embed,
  slash,
  SlashCommandContext,
  SlashCommandPartial
} from "./deps.ts";

// Load environment variables
const DISCORD_TOKEN = Deno.env.get("DISCORD_TOKEN");

if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN environment variable");
  Deno.exit(1);
}

const client = new Client();

// Register slash command
client.slash.commands.set("ethos", {
  name: "ethos",
  description: "Look up Ethos profile for a Twitter user",
  options: [{
    name: "twitter_handle",
    description: "Twitter handle to look up (with or without @)",
    type: 3, // STRING type
    required: true
  }]
} as SlashCommandPartial);

// Handle the ethos command
client.on("slashCommand", async (interaction: SlashCommandContext) => {
  if (interaction.name !== "ethos") return;

  const twitterHandle = (interaction.options[0].value as string).replace("@", "");

  await interaction.defer();

  try {
    const response = await fetch(`https://ethos.com/api/v1/profiles/${twitterHandle}`);

    if (response.ok) {
      const data = await response.json();
      
      const embed = new Embed()
        .setTitle(`Ethos Profile for @${twitterHandle}`)
        .setColor(0x0099ff)
        .addField("Ethos Score", String(data.score ?? "N/A"));
      
      await interaction.reply({ embeds: [embed] });
    } else {
      await interaction.reply({
        content: `Error: Could not fetch Ethos profile for @${twitterHandle}`,
        ephemeral: true
      });
    }
  } catch (error) {
    await interaction.reply({
      content: `An error occurred: ${error.message}`,
      ephemeral: true
    });
  }
});

client.on("ready", () => {
  console.log(`Logged in as ${client.user?.tag}!`);
});

// Connect to Discord
client.connect(DISCORD_TOKEN); 