// Make this a module
export {};

import { InteractionType } from "./deps.ts";

// Test the Discord bot with Twitter handle
async function testEthosXCommand() {
  // Simulate a Discord interaction
  const interaction = {
    type: 2, // ApplicationCommand
    id: "test_interaction_id",
    application_id: "test_app_id",
    token: "test_token",
    version: 1,
    data: {
      name: "ethosx",
      options: [{
        name: "twitter_handle",
        value: "vitalik"  // Test with a known Ethereum profile
      }]
    }
  };

  console.log("Testing /ethosx command with Twitter handle 'vitalik'...");

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

// Test the Discord bot with Discord user mention
async function testEthosCommand() {
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
        name: "user", // Discord USER type option
        value: "123456789012345678" // This is the user ID that Discord passes
      }],
      // In a real Discord interaction, this is where user info would be included
      resolved: {
        users: {
          "123456789012345678": {
            id: "123456789012345678",
            username: "TestUser",
            avatar: "abcdef123456", // Discord avatar hash
            discriminator: "0",
            global_name: "Test User"
          }
        }
      }
    }
  };

  console.log("\nTesting /ethos command with Discord user mention...");
  console.log("Discord will resolve the user to 'TestUser' with avatar hash 'abcdef123456'");
  console.log("Avatar URL will be: https://cdn.discordapp.com/avatars/123456789012345678/abcdef123456.png");

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

// Run the tests
async function runTests() {
  await testEthosCommand();
  await testEthosXCommand();
}

runTests(); 