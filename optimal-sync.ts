#!/usr/bin/env -S deno run --allow-net --allow-env

/**
 * Optimal Discord Role Sync Manager
 * 
 * This script helps manage Discord role synchronization with optimal rate limiting.
 * It monitors rate limits and schedules sync operations during low-traffic periods.
 */

const BASE_URL = Deno.env.get("SYNC_BASE_URL") || "http://localhost:8000";
const AUTH_TOKEN = Deno.env.get("SYNC_AUTH_TOKEN");

interface SyncStatus {
  success: boolean;
  status: any;
  cache: any;
  rateLimits: any;
}

interface RateLimitStatus {
  isGloballyRateLimited: boolean;
  globalRateLimitWaitTime: number;
  adaptiveDelayMultiplier: number;
  timeSinceLastRateLimit: number;
  routeRateLimits: Array<{
    route: string;
    remaining: number;
    waitTime: number;
  }>;
}

async function makeAuthenticatedRequest(endpoint: string, options: RequestInit = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> || {}),
  };

  if (AUTH_TOKEN) {
    headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;
  }

  const response = await fetch(`${BASE_URL}${endpoint}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  return response.json();
}

async function getSyncAndRateLimitStatus(): Promise<SyncStatus> {
  return await makeAuthenticatedRequest("/sync-status");
}

async function resetRateLimits(): Promise<void> {
  await makeAuthenticatedRequest("/reset-rate-limits", { method: "POST" });
  console.log("✅ Rate limits reset successfully");
}

async function triggerOptimalSync(guildId?: string): Promise<void> {
  const status = await getSyncAndRateLimitStatus();
  const rateLimits = status.rateLimits as RateLimitStatus;

  console.log("📊 Current Rate Limit Status:");
  console.log(`  Global Rate Limited: ${rateLimits.isGloballyRateLimited}`);
  console.log(`  Adaptive Delay Multiplier: ${rateLimits.adaptiveDelayMultiplier.toFixed(2)}x`);
  console.log(`  Time Since Last Rate Limit: ${(rateLimits.timeSinceLastRateLimit / 1000).toFixed(1)}s`);

  if (rateLimits.routeRateLimits.length > 0) {
    console.log("  Route Rate Limits:");
    rateLimits.routeRateLimits.forEach(route => {
      console.log(`    ${route.route}: ${route.remaining} remaining, ${(route.waitTime / 1000).toFixed(1)}s until reset`);
    });
  }

  // Check if it's safe to start sync
  const isSafeToSync = !rateLimits.isGloballyRateLimited && 
                       rateLimits.adaptiveDelayMultiplier < 2 &&
                       rateLimits.timeSinceLastRateLimit > 30000; // 30+ seconds since last rate limit

  if (!isSafeToSync) {
    console.log("⚠️ Not optimal for syncing right now:");
    if (rateLimits.isGloballyRateLimited) {
      console.log(`  - Global rate limit active (${(rateLimits.globalRateLimitWaitTime / 1000).toFixed(1)}s remaining)`);
    }
    if (rateLimits.adaptiveDelayMultiplier >= 2) {
      console.log(`  - High adaptive delay multiplier (${rateLimits.adaptiveDelayMultiplier.toFixed(2)}x)`);
    }
    if (rateLimits.timeSinceLastRateLimit <= 30000) {
      console.log(`  - Recent rate limiting (${(rateLimits.timeSinceLastRateLimit / 1000).toFixed(1)}s ago)`);
    }

    const waitTime = Math.max(
      rateLimits.globalRateLimitWaitTime,
      Math.max(0, 30000 - rateLimits.timeSinceLastRateLimit)
    );

    if (waitTime > 0) {
      console.log(`💤 Waiting ${(waitTime / 1000).toFixed(1)}s before attempting sync...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  console.log("🚀 Starting chunked sync...");
  
  let startIndex = 0;
  let isCompleted = false;
  let chunkCount = 0;

  while (!isCompleted) {
    chunkCount++;
    console.log(`\n📦 Starting chunk ${chunkCount} (from index ${startIndex})`);

    try {
      const result = await makeAuthenticatedRequest("/trigger-sync", {
        method: "POST",
        body: JSON.stringify({
          guildId,
          startIndex,
          chunkSize: 15, // Smaller chunks for better rate limit management
        }),
      });

      console.log(`✅ Chunk ${chunkCount} completed:`);
      console.log(`  - Processed: ${result.nextIndex - startIndex} users`);
      console.log(`  - Total Progress: ${result.nextIndex}/${result.totalUsers} (${((result.nextIndex / result.totalUsers) * 100).toFixed(1)}%)`);

      isCompleted = result.completed;
      startIndex = result.nextIndex;

      if (!isCompleted) {
        // Wait between chunks and check rate limits
        console.log("⏸️ Waiting 30s between chunks...");
        await new Promise(resolve => setTimeout(resolve, 30000));

        // Check rate limits before next chunk
        const updatedStatus = await getSyncAndRateLimitStatus();
        const updatedRateLimits = updatedStatus.rateLimits as RateLimitStatus;

        if (updatedRateLimits.isGloballyRateLimited || updatedRateLimits.adaptiveDelayMultiplier > 3) {
          console.log("⚠️ Rate limits detected, pausing for recovery...");
          const recoveryTime = Math.max(60000, updatedRateLimits.globalRateLimitWaitTime);
          console.log(`💤 Waiting ${(recoveryTime / 1000).toFixed(1)}s for rate limit recovery...`);
          await new Promise(resolve => setTimeout(resolve, recoveryTime));
        }
      }

    } catch (error) {
      console.error(`❌ Error in chunk ${chunkCount}:`, error);
      
      // Wait longer on errors
      console.log("💤 Waiting 60s before retrying...");
      await new Promise(resolve => setTimeout(resolve, 60000));
    }
  }

  console.log("\n🎉 Sync completed successfully!");
  
  // Final status
  const finalStatus = await getSyncAndRateLimitStatus();
  console.log(`📈 Final adaptive delay multiplier: ${finalStatus.rateLimits.adaptiveDelayMultiplier.toFixed(2)}x`);
}

async function monitorRateLimits(intervalSeconds = 30): Promise<void> {
  console.log(`🔍 Monitoring rate limits every ${intervalSeconds} seconds (Press Ctrl+C to stop)`);
  
  while (true) {
    try {
      const status = await getSyncAndRateLimitStatus();
      const rateLimits = status.rateLimits as RateLimitStatus;
      const timestamp = new Date().toLocaleTimeString();

      console.log(`\n[${timestamp}] Rate Limit Status:`);
      console.log(`  Global Limited: ${rateLimits.isGloballyRateLimited}`);
      console.log(`  Adaptive Multiplier: ${rateLimits.adaptiveDelayMultiplier.toFixed(2)}x`);
      console.log(`  Time Since Last Limit: ${(rateLimits.timeSinceLastRateLimit / 1000).toFixed(1)}s`);
      
      if (rateLimits.routeRateLimits.length > 0) {
        console.log(`  Active Route Limits: ${rateLimits.routeRateLimits.length}`);
        rateLimits.routeRateLimits
          .filter(r => r.remaining <= 10)
          .forEach(route => {
            console.log(`    ⚠️ ${route.route}: ${route.remaining} remaining`);
          });
      }

      // Sync status
      if (status.status.isRunning) {
        console.log(`  🔄 Sync Running: ${status.status.processedUsers}/${status.status.totalUsers} users`);
      }

    } catch (error) {
      console.error(`❌ Error monitoring rate limits:`, error);
    }

    await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1000));
  }
}

// CLI Interface
if (import.meta.main) {
  const command = Deno.args[0];

  switch (command) {
    case "status":
      try {
        const status = await getSyncAndRateLimitStatus();
        console.log("📊 Current Status:");
        console.log(JSON.stringify(status, null, 2));
      } catch (error) {
        console.error("❌ Error getting status:", error);
        Deno.exit(1);
      }
      break;

    case "reset-limits":
      try {
        await resetRateLimits();
      } catch (error) {
        console.error("❌ Error resetting rate limits:", error);
        Deno.exit(1);
      }
      break;

    case "optimal-sync":
      const guildId = Deno.args[1];
      try {
        await triggerOptimalSync(guildId);
      } catch (error) {
        console.error("❌ Error running optimal sync:", error);
        Deno.exit(1);
      }
      break;

    case "monitor":
      const interval = parseInt(Deno.args[1]) || 30;
      try {
        await monitorRateLimits(interval);
      } catch (error) {
        console.error("❌ Error monitoring:", error);
        Deno.exit(1);
      }
      break;

    default:
      console.log(`
🔧 Optimal Discord Role Sync Manager

Usage:
  deno run --allow-net --allow-env optimal-sync.ts <command> [options]

Commands:
  status              Show current sync and rate limit status
  reset-limits        Reset rate limit state
  optimal-sync [guild_id]  Run optimized sync with intelligent rate limiting
  monitor [interval]  Monitor rate limits continuously (default: 30s intervals)

Environment Variables:
  SYNC_BASE_URL      Base URL for sync service (default: http://localhost:8000)
  SYNC_AUTH_TOKEN    Authentication token for sync endpoints

Examples:
  deno run --allow-net --allow-env optimal-sync.ts status
  deno run --allow-net --allow-env optimal-sync.ts optimal-sync 123456789
  deno run --allow-net --allow-env optimal-sync.ts monitor 60
      `);
      Deno.exit(0);
  }
} 