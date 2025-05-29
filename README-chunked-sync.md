# Chunked Role Synchronization System

## Overview

The Ethos Discord bot now includes a chunked role synchronization system designed to work reliably within Deno Deploy's execution time limits. Instead of processing all users in one long-running operation, the sync is broken into smaller chunks that complete quickly and can be chained together.

## Key Features

- **Time-limited chunks**: Each chunk runs for a maximum of 12 minutes
- **Configurable chunk sizes**: Process 50 users per chunk by default (configurable)
- **Automatic continuation**: Chunks can automatically trigger the next chunk
- **Progress tracking**: Monitor progress across multiple chunks
- **Rate limit protection**: Enhanced Discord API rate limit handling
- **Graceful stopping**: Stop operations cleanly between chunks

## Configuration

The sync system is configured through constants in `mod.ts`:

```typescript
const SYNC_CONFIG = {
  BATCH_SIZE: 10,           // Users per batch
  CHUNK_SIZE: 50,           // Users per chunk (for Deno limits)
  MAX_EXECUTION_TIME: 12 * 60 * 1000, // 12 minutes max execution
  DELAY_BETWEEN_USERS: 2000,     // 2 seconds
  DELAY_BETWEEN_BATCHES: 5000,   // 5 seconds
  DELAY_BETWEEN_ROLE_OPS: 500    // 500ms
};
```

## Environment Variables

- `AUTO_CONTINUE_CHUNKS=true`: Automatically trigger next chunk after completion
- `DISABLE_DAILY_SYNC=true`: Disable the daily sync scheduler
- `SYNC_AUTH_TOKEN`: Optional authentication token for HTTP endpoints
- `DISCORD_GUILD_ID`: Default guild ID for sync operations

## Usage Methods

### 1. HTTP API Endpoints

Start a chunked sync:
```bash
curl -X POST http://your-service.deno.dev/trigger-sync \
  -H "Content-Type: application/json" \
  -d '{"startIndex": 0, "chunkSize": 50}'
```

Check status:
```bash
curl http://your-service.deno.dev/sync-status
```

Stop sync:
```bash
curl -X POST http://your-service.deno.dev/stop-sync
```

### 2. Discord Commands

- `/ethos_sync` - Start a sync (uses old monolithic approach)
- `/ethos_sync_status` - Check sync status
- `/ethos_sync_stop` - Stop current sync

### 3. Sync Helper Script

The `sync-helper.ts` script provides a convenient CLI interface:

```bash
# Show help
deno run --allow-net --allow-env sync-helper.ts

# Start a single chunk
deno run --allow-net --allow-env sync-helper.ts start --chunk-size 30

# Run complete sync with auto-continuation
deno run --allow-net --allow-env sync-helper.ts complete

# Check status
deno run --allow-net --allow-env sync-helper.ts status

# Stop sync
deno run --allow-net --allow-env sync-helper.ts stop
```

### 4. Makefile Commands

```bash
# Development
make dev-start          # Start service locally
make dev-status         # Check local status

# Sync operations
make complete           # Complete sync with auto-continuation
make start              # Start single chunk
make status             # Check status
make stop               # Stop sync

# Custom chunk sizes
make complete CHUNK_SIZE=100
make start CHUNK_SIZE=30
```

## How It Works

### Chunked Processing

1. **Fetch verified users**: Get all users with the verified role
2. **Process in chunks**: Take a slice of users (default: 50)
3. **Process in batches**: Within each chunk, process users in smaller batches (default: 10)
4. **Rate limiting**: Delays between users, batches, and role operations
5. **Time monitoring**: Stop before hitting execution time limits
6. **Progress tracking**: Track processed users and provide continuation info

### Continuation Pattern

When a chunk completes:
- Returns completion status and next index
- If `AUTO_CONTINUE_CHUNKS=true`, automatically triggers next chunk
- Otherwise, waits for manual trigger with the next index

### Rate Limit Protection

- **Enhanced Discord API wrapper**: Automatic retry with exponential backoff
- **Global rate limit detection**: Extra buffer time for global rate limits
- **Header monitoring**: Warnings when rate limit remaining < 5
- **Multiple retry attempts**: Up to 5 retries with proper delays

## Production Deployment

### Deno Deploy Setup

1. Deploy your service to Deno Deploy
2. Set environment variables in Deno Deploy dashboard
3. Use the HTTP endpoints or cron jobs for automation

### Automated Syncing

Option 1: Use Deno Deploy cron (see `cron.ts`):
```typescript
Deno.cron("Daily role sync", "0 2 * * *", async () => {
  await triggerChunkedRoleSync();
});
```

Option 2: External cron service:
```bash
# Daily sync at 2 AM
0 2 * * * curl -X POST https://your-service.deno.dev/trigger-sync
```

Option 3: GitHub Actions workflow:
```yaml
name: Daily Role Sync
on:
  schedule:
    - cron: '0 2 * * *'  # 2 AM daily
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger Role Sync
        run: |
          curl -X POST ${{ secrets.SYNC_URL }}/trigger-sync \
            -H "Authorization: Bearer ${{ secrets.SYNC_AUTH_TOKEN }}"
```

## Monitoring

### Status Information

The sync status includes:
- Current running state
- Guild being processed
- Progress (users processed/total)
- Duration and timing
- Current batch and last processed index
- Stop signals

### Logging

The system provides detailed logging:
- Chunk start/completion with progress
- Individual user changes
- Rate limit warnings
- Error handling and retries
- Execution time monitoring

## Troubleshooting

### Common Issues

**Sync stops unexpectedly**:
- Check execution time limits (12 minutes per chunk)
- Verify Discord token permissions
- Monitor rate limit warnings

**Rate limiting errors**:
- Increase delays in `SYNC_CONFIG`
- Reduce chunk size
- Check for other bots using the same token

**Memory issues**:
- Reduce `CHUNK_SIZE` and `BATCH_SIZE`
- Ensure proper cleanup after each chunk

### Recovery

If a sync is interrupted:
1. Check the last processed index with `/sync-status`
2. Resume with: `make start CHUNK_SIZE=50 --start-index <last-index>`
3. Or use the helper: `sync-helper.ts start --start-index <last-index>`

## Migration from Old System

The old monolithic sync system is still available but deprecated:
- `/ethos_sync` Discord command still uses old system
- `triggerRoleSync()` function is the old implementation
- New chunked system is recommended for production use

To migrate:
1. Test chunked sync with small chunk sizes
2. Update cron jobs to use new HTTP endpoints
3. Use sync helper script for manual operations
4. Monitor performance and adjust configuration as needed 