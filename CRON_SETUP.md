# Discord Bot Cron Jobs Setup

This document explains how automated tasks are scheduled for the Ethos Discord bot.

## Overview

The bot has two main automated tasks:

1. **Validator Verification** - Runs every 2 hours
2. **Batch Role Sync** - Runs every 6 hours

## Implementation

### GitHub Actions (Primary)

The primary cron implementation uses GitHub Actions (`.github/workflows/cron-jobs.yml`):

- **Validator Check**: `0 */2 * * *` (every 2 hours)
- **Batch Sync**: `0 */6 * * *` (every 6 hours)
- **Manual Trigger**: Available via GitHub Actions UI

**Advantages:**
- Reliable and free
- Easy to monitor via GitHub Actions UI
- Automatic retry on failure
- Manual trigger support
- No additional infrastructure needed

### Railway Cron (Alternative)

Railway cron services can be set up using separate services:

1. Create new Railway service for validator check
   - Use `railway-validator-cron.dockerfile`
   - Set cron schedule: `0 */2 * * *`

2. Create new Railway service for batch sync
   - Use `railway-batch-sync-cron.dockerfile` 
   - Set cron schedule: `0 */6 * * *`

## Task Details

### Validator Verification

**Purpose**: Ensures users with validator roles still own validator NFTs

**Process**:
1. Finds all users with validator roles
2. Checks if they still own validator NFTs via Ethos API
3. Demotes users who sold their validators to regular roles
4. Maintains proper role hierarchy based on Ethos scores

**Endpoint**: `POST /trigger-validator-check`

### Batch Role Sync

**Purpose**: Synchronizes roles for all verified users efficiently

**Process**:
1. Gets all users with verified roles (~11,000 users)
2. Uses optimized batch APIs to fetch Ethos data
3. Updates roles based on current scores and validator status
4. Skips recently synced users (cached for 3 days)

**Endpoint**: `POST /trigger-batch-sync`

**Performance**: 
- ~30-60 minutes (vs 3-5 hours with individual APIs)
- 99% reduction in API calls
- Handles rate limiting automatically

## Monitoring

### GitHub Actions
- Check the "Actions" tab in the GitHub repository
- View logs for each cron run
- Get notifications on failures

### Manual Testing
```bash
# Test validator check
curl -X POST "https://delicious-babies-production.up.railway.app/trigger-validator-check" \
  -H "Content-Type: application/json" \
  -d '{}'

# Test batch sync  
curl -X POST "https://delicious-babies-production.up.railway.app/trigger-batch-sync" \
  -H "Content-Type: application/json" \
  -d '{}'

# Check sync status
curl "https://delicious-babies-production.up.railway.app/sync-status"
```

### Manual Triggers

You can manually trigger jobs via:

1. **GitHub Actions UI**: Go to Actions → Discord Bot Cron Jobs → Run workflow
2. **HTTP Endpoints**: Use the curl commands above
3. **Discord Commands**: `/ethos_verify` for individual users

## Troubleshooting

### If Cron Jobs Stop Running

1. Check GitHub Actions status
2. Verify Railway service is healthy: `/health`
3. Check for rate limiting: `/sync-status`
4. Manual trigger to test functionality

### Common Issues

- **Rate limiting**: The bot has adaptive rate limiting built-in
- **API failures**: Automatic retries and fallback to individual APIs
- **Long execution**: Batch sync optimized for speed, should complete in ~1 hour

## Environment Variables

The cron jobs use the same environment variables as the main bot:

- `DISCORD_GUILD_ID`: Target Discord server
- `DISCORD_TOKEN`: Bot authentication
- `BOT_SERVICE_URL`: Main bot service URL (for Railway cron services)

## Schedule Details

All times are in UTC:

- **Validator Check**: 00:00, 02:00, 04:00, 06:00, 08:00, 10:00, 12:00, 14:00, 16:00, 18:00, 20:00, 22:00
- **Batch Sync**: 00:00, 06:00, 12:00, 18:00

The GitHub Actions workflow intelligently determines which job to run based on the current time. 