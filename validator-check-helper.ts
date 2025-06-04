#!/usr/bin/env -S deno run --allow-net --allow-env

/**
 * Validator Check Helper Script
 * 
 * This script can be used to trigger validator verification checks.
 * It can be run manually or scheduled to run hourly via cron jobs or similar.
 * 
 * Usage:
 *   deno run --allow-net --allow-env validator-check-helper.ts
 *   deno run --allow-net --allow-env validator-check-helper.ts --guild-id YOUR_GUILD_ID
 * 
 * Environment Variables:
 *   DISCORD_BOT_URL - The URL of your Discord bot service (e.g., https://your-bot.deno.dev)
 *   SYNC_AUTH_TOKEN - Optional authentication token for secure endpoints
 *   DISCORD_GUILD_ID - Default guild ID if not provided as argument
 */

interface ValidatorCheckResponse {
  success: boolean;
  message?: string;
  error?: string;
  guildId?: string;
}

interface ValidatorCheckStatus {
  success: boolean;
  status: {
    isRunning: boolean;
    shouldStop: boolean;
    currentGuild: string | null;
    startTime: number | null;
    processedUsers: number;
    totalUsers: number;
    demotedUsers: number;
    lastProcessedIndex: number;
    checkId: string | null;
    duration: number;
  };
}

async function triggerValidatorCheck(guildId?: string): Promise<ValidatorCheckResponse> {
  const botUrl = Deno.env.get("DISCORD_BOT_URL");
  if (!botUrl) {
    throw new Error("DISCORD_BOT_URL environment variable is required");
  }

  const authToken = Deno.env.get("SYNC_AUTH_TOKEN");
  const url = `${botUrl.replace(/\/$/, "")}/trigger-validator-check`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }

  const body = guildId ? JSON.stringify({ guildId }) : JSON.stringify({});

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
    });

    const data = await response.json();
    return data;
  } catch (error) {
    throw new Error(`Failed to trigger validator check: ${error}`);
  }
}

async function getValidatorCheckStatus(): Promise<ValidatorCheckStatus> {
  const botUrl = Deno.env.get("DISCORD_BOT_URL");
  if (!botUrl) {
    throw new Error("DISCORD_BOT_URL environment variable is required");
  }

  const authToken = Deno.env.get("SYNC_AUTH_TOKEN");
  const url = `${botUrl.replace(/\/$/, "")}/validator-check-status`;

  const headers: Record<string, string> = {};

  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }

  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
    });

    const data = await response.json();
    return data;
  } catch (error) {
    throw new Error(`Failed to get validator check status: ${error}`);
  }
}

async function waitForCompletion(maxWaitTimeMs = 15 * 60 * 1000): Promise<void> {
  const startTime = Date.now();
  const checkInterval = 30000; // Check every 30 seconds

  console.log("⏳ Waiting for validator verification to complete...");

  while (Date.now() - startTime < maxWaitTimeMs) {
    try {
      const statusResponse = await getValidatorCheckStatus();
      
      if (!statusResponse.success) {
        console.error("❌ Failed to get status:", statusResponse);
        return;
      }

      const status = statusResponse.status;

      if (!status.isRunning) {
        console.log("✅ Validator verification completed!");
        return;
      }

      const elapsed = Math.round(status.duration / 1000);
      const progress = status.totalUsers > 0 
        ? `${status.processedUsers}/${status.totalUsers} (${Math.round((status.processedUsers / status.totalUsers) * 100)}%)`
        : `${status.processedUsers} users`;

      console.log(`⏳ Still running... Progress: ${progress}, Demoted: ${status.demotedUsers}, Elapsed: ${elapsed}s`);

      await new Promise(resolve => setTimeout(resolve, checkInterval));
    } catch (error) {
      console.error("❌ Error checking status:", error);
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
  }

  console.log("⚠️ Maximum wait time reached, validator verification may still be running");
}

async function main() {
  console.log("🔍 Ethos Discord Bot - Validator Verification Helper");
  console.log("==================================================");

  // Parse command line arguments
  const args = Deno.args;
  let guildId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--guild-id" && i + 1 < args.length) {
      guildId = args[i + 1];
      i++; // Skip next argument as it's the guild ID value
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: deno run --allow-net --allow-env validator-check-helper.ts [--guild-id GUILD_ID]");
      console.log("");
      console.log("Options:");
      console.log("  --guild-id GUILD_ID    Specify the Discord guild ID to check");
      console.log("  --help, -h             Show this help message");
      console.log("");
      console.log("Environment Variables:");
      console.log("  DISCORD_BOT_URL        The URL of your Discord bot service (required)");
      console.log("  SYNC_AUTH_TOKEN        Optional authentication token");
      console.log("  DISCORD_GUILD_ID       Default guild ID if not provided as argument");
      Deno.exit(0);
    }
  }

  // Use provided guild ID or fall back to environment variable
  const targetGuildId = guildId || Deno.env.get("DISCORD_GUILD_ID");

  console.log(`🎯 Target Guild ID: ${targetGuildId || "default (from bot config)"}`);
  console.log(`🔗 Bot URL: ${Deno.env.get("DISCORD_BOT_URL") || "not set"}`);
  console.log("");

  try {
    // Check if there's already a verification running
    console.log("📊 Checking current status...");
    const statusResponse = await getValidatorCheckStatus();
    
    if (statusResponse.success && statusResponse.status.isRunning) {
      console.log("⚠️ Validator verification is already running!");
      console.log(`   Guild: ${statusResponse.status.currentGuild}`);
      console.log(`   Progress: ${statusResponse.status.processedUsers}/${statusResponse.status.totalUsers}`);
      console.log(`   Duration: ${Math.round(statusResponse.status.duration / 1000)}s`);
      console.log("");
      console.log("⏳ Waiting for current verification to complete...");
      await waitForCompletion();
      return;
    }

    // Trigger the validator verification
    console.log("🚀 Triggering validator verification...");
    const response = await triggerValidatorCheck(targetGuildId);

    if (!response.success) {
      console.error("❌ Failed to trigger validator verification:");
      console.error("   Error:", response.error);
      Deno.exit(1);
    }

    console.log("✅ Validator verification triggered successfully!");
    console.log(`   Guild: ${response.guildId}`);
    console.log("");

    // Wait for completion
    await waitForCompletion();

    console.log("");
    console.log("🎉 Validator verification helper completed!");

  } catch (error) {
    console.error("❌ Error:", error.message);
    Deno.exit(1);
  }
}

// Run the main function
if (import.meta.main) {
  await main();
} 