#!/usr/bin/env -S deno run --allow-net --allow-env

/**
 * Railway Cron Manager for Discord Role Sync
 * 
 * This runs as a separate service on Railway to handle scheduled operations
 * without the limitations of serverless environments.
 */

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

const SYNC_SERVICE_URL = Deno.env.get("SYNC_SERVICE_URL") || "http://localhost:8000"; 
const AUTH_TOKEN = Deno.env.get("SYNC_AUTH_TOKEN");
const DISCORD_GUILD_ID = Deno.env.get("DISCORD_GUILD_ID");

// Cron job schedules
const SCHEDULES = {
  // Every 6 hours - main role sync (spread throughout day)
  ROLE_SYNC: "0 */6 * * *",  // 00:00, 06:00, 12:00, 18:00
  
  // Every 2 hours - validator verification (more frequent)
  VALIDATOR_CHECK: "0 */2 * * *", // Every 2 hours
  
  // Daily cache cleanup at 3 AM
  CACHE_CLEANUP: "0 3 * * *",
  
  // Health check every 15 minutes
  HEALTH_CHECK: "*/15 * * * *"
};

interface CronJob {
  name: string;
  schedule: string;
  endpoint: string;
  description: string;
}

const CRON_JOBS: CronJob[] = [
  {
    name: "Validator Verification",
    schedule: "0 */2 * * *", // Every 2 hours
    endpoint: "/trigger-validator-check",
    description: "Check users with validator roles to ensure they still own validator NFTs"
  },
  {
    name: "Batch Role Sync", 
    schedule: "0 */6 * * *", // Every 6 hours
    endpoint: "/trigger-batch-sync",
    description: "Sync roles for all verified users using optimized batch APIs"
  }
];

// Get the main bot service URL
const BOT_SERVICE_URL = Deno.env.get("BOT_SERVICE_URL") || "https://delicious-babies-production.up.railway.app";

// Helper function to make HTTP requests to the bot service
async function makeRequest(endpoint: string, data: any = {}): Promise<any> {
  try {
    const url = `${BOT_SERVICE_URL}${endpoint}`;
    console.log(`🌐 Making request to: ${url}`);
    
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    console.log(`✅ Request successful:`, result);
    return result;
  } catch (error) {
    console.error(`❌ Request failed:`, error);
    throw error;
  }
}

// Cron job execution functions
const cronFunctions = {
  async validatorCheck() {
    console.log("🔍 Starting scheduled validator verification...");
    
    try {
      const result = await makeRequest("/trigger-validator-check");
      console.log("✅ Validator verification triggered successfully");
      return result;
    } catch (error) {
      console.error("❌ Validator verification failed:", error);
      throw error;
    }
  },

  async batchSync() {
    console.log("🔄 Starting scheduled batch role sync...");
    
    try {
      // Check if a sync is already running
      const status = await makeRequest("/sync-status");
      if (status.status.isRunning) {
        console.log("⏭️ Sync already running, skipping this scheduled run");
        return;
      }

      // Start batch sync
      const result = await makeRequest("/trigger-batch-sync");
      console.log("✅ Batch sync triggered successfully");
      return result;
    } catch (error) {
      console.error("❌ Batch sync failed:", error);
      throw error;
    }
  }
};

// Main cron execution based on schedule
async function executeCronJob(jobName: string) {
  console.log(`🕐 [${new Date().toISOString()}] Executing cron job: ${jobName}`);
  
  try {
    switch (jobName) {
      case "validator-check":
        await cronFunctions.validatorCheck();
        break;
      case "batch-sync":
        await cronFunctions.batchSync();
        break;
      default:
        throw new Error(`Unknown cron job: ${jobName}`);
    }
    
    console.log(`✅ [${new Date().toISOString()}] Cron job completed: ${jobName}`);
  } catch (error) {
    console.error(`❌ [${new Date().toISOString()}] Cron job failed: ${jobName}`, error);
    Deno.exit(1); // Exit with error code for Railway to detect failure
  }
}

// Health check endpoint
async function handleHealthCheck(): Promise<Response> {
  return new Response(
    JSON.stringify({
      status: "healthy",
      service: "railway-cron",
      timestamp: new Date().toISOString(),
      botServiceUrl: BOT_SERVICE_URL,
      availableJobs: CRON_JOBS.map(job => ({
        name: job.name,
        schedule: job.schedule,
        description: job.description
      }))
    }),
    {
      headers: { "Content-Type": "application/json" },
    }
  );
}

// Check if this is being run as a cron job
const args = Deno.args;
if (args.length > 0) {
  const jobName = args[0];
  console.log(`🚀 Railway Cron Service - Running job: ${jobName}`);
  await executeCronJob(jobName);
} else {
  // Run as HTTP service for health checks
  console.log("🌐 Railway Cron Service - Starting HTTP server for health checks");
  console.log("Available cron jobs:");
  CRON_JOBS.forEach(job => {
    console.log(`  - ${job.name}: ${job.schedule} (${job.description})`);
  });
  
  const server = Deno.serve({ port: 8000 }, async (req) => {
    const url = new URL(req.url);
    
    if (url.pathname === "/health") {
      return await handleHealthCheck();
    }
    
    return new Response("Railway Cron Service", { status: 200 });
  });
  
  console.log("✅ Cron service health check server running on port 8000");
} 