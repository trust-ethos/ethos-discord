// Make this a module
export {};

// Test the ethos_verify command
async function testEthosVerifyCommand() {
  // Simulate a Discord interaction for a verification request
  const interaction = {
    type: 2, // ApplicationCommand
    id: "test_interaction_id",
    application_id: "test_app_id",
    token: "test_token",
    version: 1,
    guild_id: "123456789012345678", // Replace with your actual guild ID
    member: {
      user: {
        id: "123456789012345678", // Replace with your actual user ID
        username: "TestUser",
        avatar: "abcdef123456",
        discriminator: "0",
        global_name: "Test User"
      }
    },
    data: {
      name: "ethos_verify"
      // No options needed for this command
    }
  };

  console.log("Testing /ethos_verify command...");
  console.log(`Guild ID: ${interaction.guild_id}, User ID: ${interaction.member.user.id}`);

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

// Run the test
testEthosVerifyCommand(); 