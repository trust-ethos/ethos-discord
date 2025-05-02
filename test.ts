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
            global_name: "Dr. Test User" // Display name that appears in Discord
          }
        }
      }
    }
  };

  console.log("\nTesting /ethos command with Discord user mention...");
  console.log("Discord will resolve the user to 'TestUser' with display name 'Dr. Test User'");
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

// Test the ethos_verify command 
async function testEthosVerifyCommand() {
  // Simulate a Discord interaction for a verification request
  const interaction = {
    type: 2, // ApplicationCommand
    id: "test_interaction_id",
    application_id: "test_app_id",
    token: "test_token",
    version: 1,
    guild_id: "987654321098765432", // Server ID
    member: {
      user: {
        id: "123456789012345678", // User ID of the person verifying
        username: "TestUser",
        avatar: "abcdef123456",
        discriminator: "0",
        global_name: "Dr. Test User"
      }
    },
    data: {
      name: "ethos_verify"
      // No options needed for this command
    }
  };

  console.log("\nTesting /ethos_verify command with score-based role assignment...");
  console.log(`Guild ID: ${interaction.guild_id}, User ID: ${interaction.member.user.id}`);
  console.log("This will:");
  console.log("1. Remove any existing Ethos roles");
  console.log("2. Fetch the user's Ethos profile");
  console.log("3. Assign the verified role");
  console.log("4. Assign a score-based role depending on their score");

  try {
    const response = await fetch("http://localhost:8000", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(interaction)
    });

    console.log("\nResponse Status:", response.status);
    
    if (response.ok) {
      const data = await response.json();
      console.log("\nResponse Data:");
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log("Error response:", await response.text());
    }
  } catch (error) {
    console.error("Error:", error);
  }
}

// Run the tests
async function runTests() {
  await testEthosCommand();
  await testEthosXCommand();
  await testEthosVerifyCommand();
}

runTests(); 