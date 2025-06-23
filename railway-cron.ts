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
  handler: () => Promise<void>;
  lastRun?: number;
  nextRun?: number;
  isRunning: boolean;
}

let cronJobs: CronJob[] = [];
let isShuttingDown = false;

// Utility function for authenticated requests
async function makeRequest(endpoint: string, options: RequestInit = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> || {}),
  };

  if (AUTH_TOKEN) {
    headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;
  }

  try {
    const response = await fetch(`${SYNC_SERVICE_URL}${endpoint}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    return await response.json();
  } catch (error) {
    console.error(`❌ Request failed for ${endpoint}:`, error);
    throw error;
  }
}

// Cron job handlers
const cronHandlers = {
  async roleSync() {
    console.log("🔄 Starting scheduled role synchronization...");
    
    try {
      // Check if a sync is already running
      const status = await makeRequest("/sync-status");
      if (status.status.isRunning) {
        console.log("⏭️ Sync already running, skipping this scheduled run");
        return;
      }

      // Check rate limit status before starting
      const rateLimits = status.rateLimits;
      if (rateLimits.isGloballyRateLimited || rateLimits.adaptiveDelayMultiplier > 2) {
        console.log("⚠️ Rate limits too high, delaying sync by 30 minutes");
        // Could reschedule or just skip this run
        return;
      }

      // Start chunked sync with conservative settings
      let startIndex = 0;
      let completed = false;
      let chunkCount = 0;

      while (!completed && !isShuttingDown) {
        chunkCount++;
        console.log(`📦 Processing chunk ${chunkCount} (from index ${startIndex})`);

        const result = await makeRequest("/trigger-sync", {
          method: "POST",
          body: JSON.stringify({
            guildId: DISCORD_GUILD_ID,
            startIndex,
            chunkSize: 20, // Conservative chunk size
          }),
        });

        console.log(`✅ Chunk ${chunkCount}: ${result.nextIndex - startIndex} users processed`);
        console.log(`📊 Progress: ${result.nextIndex}/${result.totalUsers} (${((result.nextIndex / result.totalUsers) * 100).toFixed(1)}%)`);

        completed = result.completed;
        startIndex = result.nextIndex;

        if (!completed) {
          // Wait between chunks and check if we should continue
          console.log("⏸️ Waiting 45s between chunks...");
          await new Promise(resolve => setTimeout(resolve, 45000));

          // Check rate limits before continuing
          const updatedStatus = await makeRequest("/sync-status");
          if (updatedStatus.rateLimits.adaptiveDelayMultiplier > 3) {
            console.log("⚠️ Rate limits too high, stopping sync early");
            break;
          }
        }
      }

      console.log("✅ Scheduled role sync completed successfully");
    } catch (error) {
      console.error("❌ Error in scheduled role sync:", error);
    }
  },

  async validatorCheck() {
    console.log("🔍 Starting scheduled validator verification...");
    
    try {
      // Check if validator check is already running
      const status = await makeRequest("/validator-check-status");
      if (status.status.isRunning) {
        console.log("⏭️ Validator check already running, skipping");
        return;
      }

      await makeRequest("/trigger-validator-check", {
        method: "POST",
        body: JSON.stringify({
          guildId: DISCORD_GUILD_ID,
        }),
      });

      console.log("✅ Validator verification triggered successfully");
    } catch (error) {
      console.error("❌ Error in scheduled validator check:", error);
    }
  },

  async cacheCleanup() {
    console.log("🧹 Starting cache cleanup...");
    
    try {
      const stats = await makeRequest("/cache-stats");
      console.log(`📊 Cache stats: ${stats.cache.totalEntries} entries`);
      
      // Log cache age information
      if (stats.cache.oldestEntryDate) {
        console.log(`📅 Oldest entry: ${stats.cache.oldestEntryDate}`);
        console.log(`📅 Newest entry: ${stats.cache.newestEntryDate}`);
      }
      
      console.log("✅ Cache cleanup check completed");
    } catch (error) {
      console.error("❌ Error in cache cleanup:", error);
    }
  },

  async healthCheck() {
    try {
      const health = await makeRequest("/health");
      // Only log health check results if there are issues
      if (!health || health.status !== "healthy") {
        console.log("⚠️ Health check failed:", health);
      }
    } catch (error) {
      console.error("❌ Health check failed:", error);
    }
  }
};

// Simple cron parser (basic implementation)
function parseCronExpression(expression: string): { 
  minutes: number[], 
  hours: number[], 
  days: number[], 
  months: number[], 
  weekdays: number[] 
} {
  const parts = expression.split(' ');
  if (parts.length !== 5) {
    throw new Error('Invalid cron expression');
  }

  const parseField = (field: string, max: number): number[] => {
    if (field === '*') return Array.from({ length: max }, (_, i) => i);
    if (field.includes('/')) {
      const [range, step] = field.split('/');
      const stepNum = parseInt(step);
      if (range === '*') {
        return Array.from({ length: max }, (_, i) => i).filter(i => i % stepNum === 0);
      }
    }
    if (field.includes(',')) {
      return field.split(',').map(n => parseInt(n));
    }
    return [parseInt(field)];
  };

  return {
    minutes: parseField(parts[0], 60),
    hours: parseField(parts[1], 24),
    days: parseField(parts[2], 32), // 1-31
    months: parseField(parts[3], 13), // 1-12
    weekdays: parseField(parts[4], 7), // 0-6
  };
}

function shouldRunNow(schedule: string, lastRun?: number): boolean {
  const now = new Date();
  const cron = parseCronExpression(schedule);
  
  // Check if current time matches cron schedule
  const matches = cron.minutes.includes(now.getMinutes()) &&
                 cron.hours.includes(now.getHours()) &&
                 (cron.days.includes(now.getDate()) || cron.days.length === 31) &&
                 (cron.months.includes(now.getMonth() + 1) || cron.months.length === 12) &&
                 (cron.weekdays.includes(now.getDay()) || cron.weekdays.length === 7);

  // Don't run if we ran in the last 50 seconds (avoid duplicate runs)
  const timeSinceLastRun = lastRun ? now.getTime() - lastRun : Infinity;
  
  return matches && timeSinceLastRun > 50000;
}

// Initialize cron jobs
function initializeCronJobs() {
  cronJobs = [
    {
      name: "Role Sync",
      schedule: SCHEDULES.ROLE_SYNC,
      handler: cronHandlers.roleSync,
      isRunning: false,
    },
    {
      name: "Validator Check", 
      schedule: SCHEDULES.VALIDATOR_CHECK,
      handler: cronHandlers.validatorCheck,
      isRunning: false,
    },
    {
      name: "Cache Cleanup",
      schedule: SCHEDULES.CACHE_CLEANUP, 
      handler: cronHandlers.cacheCleanup,
      isRunning: false,
    },
    {
      name: "Health Check",
      schedule: SCHEDULES.HEALTH_CHECK,
      handler: cronHandlers.healthCheck,
      isRunning: false,
    },
  ];

  console.log("📅 Cron jobs initialized:");
  cronJobs.forEach(job => {
    console.log(`  - ${job.name}: ${job.schedule}`);
  });
}

// Main cron loop
async function runCronLoop() {
  console.log("🕐 Starting cron loop...");
  
  while (!isShuttingDown) {
    const now = Date.now();
    
    for (const job of cronJobs) {
      if (!job.isRunning && shouldRunNow(job.schedule, job.lastRun)) {
        console.log(`▶️ Running scheduled job: ${job.name}`);
        
        job.isRunning = true;
        job.lastRun = now;
        
        try {
          await job.handler();
        } catch (error) {
          console.error(`❌ Error in cron job ${job.name}:`, error);
        } finally {
          job.isRunning = false;
        }
      }
    }
    
    // Check every minute
    await new Promise(resolve => setTimeout(resolve, 60000));
  }
}

// HTTP server for status and control
async function startStatusServer() {
  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    
    if (url.pathname === "/cron-status" && req.method === "GET") {
      return new Response(JSON.stringify({
        success: true,
        jobs: cronJobs.map(job => ({
          name: job.name,
          schedule: job.schedule,
          lastRun: job.lastRun ? new Date(job.lastRun).toISOString() : null,
          isRunning: job.isRunning,
        })),
        isShuttingDown,
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    
    if (url.pathname === "/health" && req.method === "GET") {
      return new Response(JSON.stringify({
        status: "healthy",
        timestamp: new Date().toISOString(),
        uptime: process.uptime?.() || 0,
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    
    return new Response("Cron Manager", { status: 200 });
  };

  const port = parseInt(Deno.env.get("PORT") || "8001");
  console.log(`🌐 Cron status server starting on port ${port}`);
  
  await serve(handler, { port });
}

// Graceful shutdown
function setupGracefulShutdown() {
  const shutdown = () => {
    console.log("🛑 Received shutdown signal, stopping cron jobs...");
    isShuttingDown = true;
    
    // Wait for running jobs to complete
    const waitForJobs = async () => {
      const runningJobs = cronJobs.filter(job => job.isRunning);
      if (runningJobs.length > 0) {
        console.log(`⏳ Waiting for ${runningJobs.length} jobs to complete...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
        await waitForJobs();
      }
    };
    
    waitForJobs().then(() => {
      console.log("✅ Graceful shutdown completed");
      Deno.exit(0);
    });
  };

  // Handle various shutdown signals
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);
}

// Main execution
if (import.meta.main) {
  console.log("🚀 Discord Role Sync Cron Manager starting...");
  
  if (!DISCORD_GUILD_ID) {
    console.error("❌ DISCORD_GUILD_ID environment variable required");
    Deno.exit(1);
  }
  
  setupGracefulShutdown();
  initializeCronJobs();
  
  // Start both the cron loop and status server concurrently
  Promise.all([
    runCronLoop(),
    startStatusServer(),
  ]).catch(error => {
    console.error("❌ Fatal error:", error);
    Deno.exit(1);
  });
} 