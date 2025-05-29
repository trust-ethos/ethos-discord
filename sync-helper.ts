#!/usr/bin/env deno run --allow-net --allow-env

/**
 * Ethos Discord Role Sync Helper
 * 
 * This script helps manage chunked role synchronization operations
 * that are compatible with Deno Deploy's execution time limits.
 */

interface SyncResponse {
  success: boolean;
  message?: string;
  completed?: boolean;
  nextIndex?: number;
  totalUsers?: number;
  error?: string;
}

interface SyncStatus {
  success: boolean;
  status: {
    isRunning: boolean;
    shouldStop: boolean;
    currentGuild: string | null;
    startTime: number | null;
    processedUsers: number;
    totalUsers: number;
    currentBatch: number;
    lastProcessedIndex: number;
    duration: number;
  };
}

class SyncManager {
  private baseUrl: string;
  private authToken?: string;

  constructor(baseUrl: string, authToken?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.authToken = authToken;
  }

  private async makeRequest(endpoint: string, method = 'GET', body?: any): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    return fetch(`${this.baseUrl}${endpoint}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
  }

  async startChunkedSync(guildId?: string, startIndex = 0, chunkSize = 50): Promise<SyncResponse> {
    try {
      const response = await this.makeRequest('/trigger-sync', 'POST', {
        guildId,
        startIndex,
        chunkSize
      });

      return await response.json();
    } catch (error) {
      return { success: false, error: `Failed to start sync: ${error}` };
    }
  }

  async stopSync(): Promise<SyncResponse> {
    try {
      const response = await this.makeRequest('/stop-sync', 'POST');
      return await response.json();
    } catch (error) {
      return { success: false, error: `Failed to stop sync: ${error}` };
    }
  }

  async getStatus(): Promise<SyncStatus> {
    try {
      const response = await this.makeRequest('/sync-status', 'GET');
      return await response.json();
    } catch (error) {
      return { 
        success: false, 
        status: {
          isRunning: false,
          shouldStop: false,
          currentGuild: null,
          startTime: null,
          processedUsers: 0,
          totalUsers: 0,
          currentBatch: 0,
          lastProcessedIndex: 0,
          duration: 0
        }
      };
    }
  }

  async runCompleteSync(guildId?: string, chunkSize = 50): Promise<void> {
    console.log('🚀 Starting complete chunked role synchronization...');
    
    let currentIndex = 0;
    let isCompleted = false;
    let totalUsers = 0;
    let chunkCount = 0;

    while (!isCompleted) {
      chunkCount++;
      console.log(`\n📦 Starting chunk ${chunkCount} from index ${currentIndex}...`);
      
      const result = await this.startChunkedSync(guildId, currentIndex, chunkSize);
      
      if (!result.success) {
        console.error(`❌ Chunk ${chunkCount} failed:`, result.error);
        break;
      }

      console.log(`✅ Chunk ${chunkCount} triggered successfully`);
      
      // Wait for chunk to complete
      await this.waitForChunkCompletion();
      
      // Get the final status to see progress
      const status = await this.getStatus();
      if (status.success) {
        currentIndex = status.status.lastProcessedIndex + 1;
        totalUsers = status.status.totalUsers;
        
        if (totalUsers > 0) {
          const progress = ((currentIndex / totalUsers) * 100).toFixed(1);
          console.log(`📊 Progress: ${currentIndex}/${totalUsers} (${progress}%)`);
        }
        
        isCompleted = currentIndex >= totalUsers;
      } else {
        console.error('❌ Failed to get sync status');
        break;
      }

      if (!isCompleted) {
        console.log(`⏸️ Waiting 10 seconds before next chunk...`);
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }

    if (isCompleted) {
      console.log(`\n🎉 Complete sync finished! Processed ${totalUsers} users in ${chunkCount} chunks.`);
    } else {
      console.log(`\n⚠️ Sync stopped. Resume with: --start-index ${currentIndex}`);
    }
  }

  private async waitForChunkCompletion(): Promise<void> {
    const maxWaitTime = 15 * 60 * 1000; // 15 minutes
    const checkInterval = 5000; // 5 seconds
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      const status = await this.getStatus();
      
      if (!status.success || !status.status.isRunning) {
        return; // Sync completed or failed
      }

      const duration = Math.floor(status.status.duration / 1000);
      console.log(`⏳ Chunk in progress... ${status.status.processedUsers}/${status.status.totalUsers} users (${duration}s elapsed)`);
      
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    console.warn('⚠️ Chunk taking longer than expected, continuing anyway...');
  }

  formatStatus(status: SyncStatus): void {
    if (!status.success) {
      console.log('❌ Failed to get sync status');
      return;
    }

    const s = status.status;
    
    if (!s.isRunning) {
      console.log('✅ No sync currently running');
      return;
    }

    const minutes = Math.floor(s.duration / 60000);
    const seconds = Math.floor((s.duration % 60000) / 1000);
    const progress = s.totalUsers > 0 ? ((s.processedUsers / s.totalUsers) * 100).toFixed(1) : '0';

    console.log('🔄 Sync Status:');
    console.log(`   ⏱️  Duration: ${minutes}m ${seconds}s`);
    console.log(`   👥 Progress: ${s.processedUsers}/${s.totalUsers} users (${progress}%)`);
    console.log(`   🎯 Guild: ${s.currentGuild}`);
    console.log(`   📦 Current Batch: ${s.currentBatch}`);
    console.log(`   📍 Last Index: ${s.lastProcessedIndex}`);
    if (s.shouldStop) {
      console.log('   🛑 Stop signal sent');
    }
  }
}

// CLI Interface
async function main() {
  const args = Deno.args;
  const baseUrl = Deno.env.get('SYNC_BASE_URL') || 'http://localhost:8000';
  const authToken = Deno.env.get('SYNC_AUTH_TOKEN');
  const guildId = Deno.env.get('DISCORD_GUILD_ID');

  const manager = new SyncManager(baseUrl, authToken);

  if (args.length === 0) {
    console.log(`
🔧 Ethos Discord Role Sync Helper

Usage:
  deno run --allow-net --allow-env sync-helper.ts <command> [options]

Commands:
  start [--guild-id <id>] [--start-index <n>] [--chunk-size <n>]
    Start a chunked sync operation
    
  complete [--guild-id <id>] [--chunk-size <n>]
    Run a complete sync with automatic chunk continuation
    
  status
    Get current sync status
    
  stop
    Stop the current sync operation

Environment Variables:
  SYNC_BASE_URL      - Base URL of the sync service (default: http://localhost:8000)
  SYNC_AUTH_TOKEN    - Optional authentication token
  DISCORD_GUILD_ID   - Default guild ID to sync

Examples:
  deno run --allow-net --allow-env sync-helper.ts start --chunk-size 30
  deno run --allow-net --allow-env sync-helper.ts complete
  deno run --allow-net --allow-env sync-helper.ts status
  deno run --allow-net --allow-env sync-helper.ts stop
`);
    return;
  }

  const command = args[0];

  switch (command) {
    case 'start': {
      const guildIdArg = args.includes('--guild-id') ? args[args.indexOf('--guild-id') + 1] : guildId;
      const startIndex = args.includes('--start-index') ? parseInt(args[args.indexOf('--start-index') + 1]) : 0;
      const chunkSize = args.includes('--chunk-size') ? parseInt(args[args.indexOf('--chunk-size') + 1]) : 50;

      console.log(`🚀 Starting chunked sync...`);
      console.log(`   Guild: ${guildIdArg || 'default'}`);
      console.log(`   Start Index: ${startIndex}`);
      console.log(`   Chunk Size: ${chunkSize}`);

      const result = await manager.startChunkedSync(guildIdArg, startIndex, chunkSize);
      console.log(result.success ? '✅ Sync started' : `❌ Failed: ${result.error}`);
      break;
    }

    case 'complete': {
      const guildIdArg = args.includes('--guild-id') ? args[args.indexOf('--guild-id') + 1] : guildId;
      const chunkSize = args.includes('--chunk-size') ? parseInt(args[args.indexOf('--chunk-size') + 1]) : 50;

      await manager.runCompleteSync(guildIdArg, chunkSize);
      break;
    }

    case 'status': {
      const status = await manager.getStatus();
      manager.formatStatus(status);
      break;
    }

    case 'stop': {
      console.log('🛑 Stopping sync...');
      const result = await manager.stopSync();
      console.log(result.success ? '✅ Stop signal sent' : `❌ Failed: ${result.error}`);
      break;
    }

    default:
      console.error(`❌ Unknown command: ${command}`);
      console.log('Run without arguments to see usage information.');
  }
}

if (import.meta.main) {
  await main();
} 