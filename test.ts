// Make this a module
export {};

import { InteractionType } from "./deps.ts";

// Test the Discord bot
async function testDiscordBot() {
  // Simulate a Discord interaction
  const interaction = {
    type: 2, // ApplicationCommand
    id: "test_interaction_id",
    application_id: "test_app_id",
    token: "test_token",
    version: 1,
    data: {
      name: "ethos",
      options: [{
        name: "twitter_handle",
        value: "vitalik"  // Test with a known Ethereum profile
      }]
    }
  };

  console.log("Testing /ethos command with @vitalik...");

  try {
    const response = await fetch("http://localhost:8000", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(interaction)
    });

    const data = await response.json();
    console.log("\nResponse Status:", response.status);
    console.log("\nResponse Data:");
    console.log(JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("Error:", error);
  }
}

// Run the test
testDiscordBot(); 