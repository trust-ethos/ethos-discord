# Validator Verification System

This document explains the automated validator verification system that checks Discord users with validator roles to ensure they still own their validator NFTs.

## Overview

The validator verification system:

1. **Identifies users with validator roles** - Finds all Discord users who have any of the validator roles (Exemplary Validator, Reputable Validator, etc.)
2. **Checks validator NFT ownership** - Uses the Ethos API to verify if each user still owns a validator NFT
3. **Demotes users who no longer own validators** - Removes validator roles and assigns equivalent regular roles based on their Ethos score

## Validator Roles

The system handles these validator roles:
- `ETHOS_VALIDATOR_EXEMPLARY` (Score >= 2000 + validator)
- `ETHOS_VALIDATOR_REPUTABLE` (Score >= 1600 + validator)  
- `ETHOS_VALIDATOR_NEUTRAL` (Score >= 1200 + validator)
- `ETHOS_VALIDATOR_QUESTIONABLE` (Score >= 800 + validator)

When a user loses their validator NFT, they get demoted to:
- `ETHOS_ROLE_EXEMPLARY` (Score >= 2000)
- `ETHOS_ROLE_REPUTABLE` (Score >= 1600)
- `ETHOS_ROLE_NEUTRAL` (Score >= 1200)
- `ETHOS_ROLE_QUESTIONABLE` (Score >= 800)
- `ETHOS_ROLE_UNTRUSTED` (Score < 800 or no valid profile)

## API Endpoints

### POST /trigger-validator-check
Triggers a validator verification check.

**Request Body:**
```json
{
  "guildId": "your-guild-id" // Optional, uses DISCORD_GUILD_ID env var if not provided
}
```

**Response:**
```json
{
  "success": true,
  "message": "Validator verification triggered",
  "guildId": "123456789"
}
```

### GET /validator-check-status
Gets the current status of validator verification.

**Response:**
```json
{
  "success": true,
  "status": {
    "isRunning": false,
    "shouldStop": false,
    "currentGuild": null,
    "startTime": null,
    "processedUsers": 25,
    "totalUsers": 25,
    "demotedUsers": 3,
    "lastProcessedIndex": 24,
    "checkId": null,
    "duration": 0
  }
}
```

### POST /stop-validator-check
Stops a running validator verification.

**Response:**
```json
{
  "success": true,
  "message": "Stop signal sent to running validator verification",
  "wasStopped": true
}
```

## Setting Up Hourly Validation

### Option 1: Using Deno.cron (Recommended)

The easiest way to set up hourly validator verification is using Deno's built-in cron functionality. This is now **the recommended approach** for Deno Deploy deployments.

1. **Enable automatic validation by setting an environment variable:**
   ```bash
   ENABLE_AUTO_VALIDATOR_CHECK=true
   ```

2. **Deploy to Deno Deploy:**
   The cron job will automatically be registered and visible in your [Deno Deploy dashboard](https://dash.deno.com) under the "Cron" tab.

3. **The system will automatically:**
   - Run every hour at minute 0 (e.g., 1:00, 2:00, 3:00...)
   - Use your `DISCORD_GUILD_ID` environment variable
   - Retry failed runs after 1s, 5s, and 10s delays
   - Log all activity with `[CRON]` prefix

**Benefits of using Deno.cron:**
- ✅ **Zero external dependencies** - Built into Deno Deploy
- ✅ **High availability** - Managed by Deno Deploy infrastructure  
- ✅ **Automatic retries** - Built-in retry mechanism for failures
- ✅ **Dashboard monitoring** - View cron status in Deno Deploy dashboard
- ✅ **Serverless execution** - No need to maintain separate servers
- ✅ **Cost effective** - Charged same as HTTP requests

**Configuration:**
```typescript
// In your bot code - this is already added to mod.ts
Deno.cron("Hourly Validator Verification", "0 * * * *", {
  backoffSchedule: [1000, 5000, 10000], // Retry after 1s, 5s, 10s if failed
}, async () => {
  await performValidatorVerification(guildId);
});
```

### Option 2: Using the Helper Script with Cron (Alternative)

1. **Set up environment variables:**
   ```bash
   export DISCORD_BOT_URL="https://your-bot.deno.dev"
   export SYNC_AUTH_TOKEN="your-auth-token"  # Optional but recommended
   export DISCORD_GUILD_ID="your-guild-id"
   ```

2. **Test the helper script:**
   ```bash
   deno run --allow-net --allow-env validator-check-helper.ts
   ```

3. **Set up cron job to run every hour:**
   ```bash
   # Edit crontab
   crontab -e
   
   # Add this line to run every hour at minute 0
   0 * * * * cd /path/to/your/bot && /usr/local/bin/deno run --allow-net --allow-env validator-check-helper.ts >> /var/log/validator-check.log 2>&1
   ```

### Option 3: Using GitHub Actions

Create `.github/workflows/validator-check.yml`:

```yaml
name: Hourly Validator Verification

on:
  schedule:
    # Run every hour at minute 0
    - cron: '0 * * * *'
  workflow_dispatch: # Allow manual triggering

jobs:
  validator-check:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger Validator Verification
        run: |
          curl -X POST "${{ secrets.DISCORD_BOT_URL }}/trigger-validator-check" \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer ${{ secrets.SYNC_AUTH_TOKEN }}" \
            -d '{"guildId": "${{ secrets.DISCORD_GUILD_ID }}"}'
```

**Required GitHub Secrets:**
- `DISCORD_BOT_URL`: Your bot's URL (e.g., `https://your-bot.deno.dev`)
- `SYNC_AUTH_TOKEN`: Your authentication token
- `DISCORD_GUILD_ID`: Your Discord guild ID

### Option 4: Using External Monitoring Service

Services like UptimeRobot, Pingdom, or similar can be configured to make HTTP requests on a schedule:

- **URL**: `https://your-bot.deno.dev/trigger-validator-check`
- **Method**: POST
- **Headers**: 
  - `Content-Type: application/json`
  - `Authorization: Bearer YOUR_AUTH_TOKEN`
- **Body**: `{"guildId": "your-guild-id"}`
- **Schedule**: Every hour

## Configuration

### Environment Variables

- `DISCORD_BOT_URL`: Your bot service URL (for helper script)
- `SYNC_AUTH_TOKEN`: Optional authentication token for API endpoints
- `DISCORD_GUILD_ID`: Default Discord guild ID
- `DISCORD_TOKEN`: Discord bot token
- `DISCORD_PUBLIC_KEY`: Discord application public key

### Timing Configuration

You can adjust the verification timing in `VALIDATOR_CHECK_CONFIG`:

```typescript
const VALIDATOR_CHECK_CONFIG = {
  BATCH_SIZE: 5, // Users per batch (smaller for API stability)
  DELAY_BETWEEN_USERS: 3000, // 3 seconds between user checks
  DELAY_BETWEEN_BATCHES: 10000, // 10 seconds between batches
  MAX_EXECUTION_TIME: 10 * 60 * 1000, // 10 minutes max execution
};
```

## Monitoring

### Logs

The system provides detailed logging with the `[VALIDATOR-CHECK]` prefix:

```
[VALIDATOR-CHECK] === Starting validator verification ===
[VALIDATOR-CHECK] Fetching users with validator roles from guild: 123456789
[VALIDATOR-CHECK] Found 25 users with validator roles
[VALIDATOR-CHECK] Processing batch 1/5 (users 1-5/25)
[VALIDATOR-CHECK] [1/25] Checking validator status for user: 987654321
[VALIDATOR-CHECK] [1/25] User 987654321 no longer owns validator, demoting from validator roles
[VALIDATOR-CHECK] 👤 User 987654321 (1/25): Removed Exemplary Validator role, Added Exemplary role
[VALIDATOR-CHECK] === Validator verification complete ===
[VALIDATOR-CHECK] Duration: 45.2s
[VALIDATOR-CHECK] Processed: 25 users
[VALIDATOR-CHECK] Demoted: 3 users
[VALIDATOR-CHECK] Errors: 0 users
[VALIDATOR-CHECK] Total changes: 6
```

### Status Monitoring

You can check the current status at any time:

```bash
curl https://your-bot.deno.dev/validator-check-status
```

### Health Checks

The bot includes a health check endpoint:

```bash
curl https://your-bot.deno.dev/health
```

## Error Handling

The system includes comprehensive error handling:

- **Rate limiting**: Respects Discord API rate limits with automatic retries
- **Network errors**: Retries with exponential backoff
- **API failures**: Continues processing other users if individual checks fail
- **Execution limits**: Stops after 10 minutes to prevent timeouts
- **Graceful shutdown**: Can be stopped mid-process if needed

## Security

- **Authentication**: Use `SYNC_AUTH_TOKEN` to secure API endpoints
- **Rate limiting**: Built-in delays prevent API abuse
- **Validation**: All inputs are validated before processing
- **Logging**: No sensitive data is logged

## Troubleshooting

### Common Issues

1. **"No users with validator roles found"**
   - Check that users actually have validator roles assigned
   - Verify the correct guild ID is being used

2. **"Failed to fetch guild members"**
   - Ensure the bot has proper permissions in the Discord server
   - Check that the Discord token is valid

3. **"Validator verification already in progress"**
   - Another process is already running
   - Wait for completion or stop it with `/stop-validator-check`

4. **Rate limiting errors**
   - The system handles these automatically
   - Consider increasing delays if you see frequent rate limits

### Manual Testing

Test individual components:

```bash
# Test the helper script
deno run --allow-net --allow-env validator-check-helper.ts --help

# Test the API endpoint
curl -X POST https://your-bot.deno.dev/trigger-validator-check \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"guildId": "your-guild-id"}'
```

## Performance Considerations

- **Batch processing**: Users are processed in small batches to prevent overwhelming the APIs
- **Rate limiting**: Built-in delays respect Discord and Ethos API limits
- **Execution limits**: Maximum 10-minute execution time prevents runaway processes
- **Memory usage**: Minimal memory footprint, suitable for serverless environments

The system is designed to be efficient and reliable for hourly execution in production environments. 