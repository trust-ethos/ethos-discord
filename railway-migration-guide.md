# 🚂 Migration Guide: Deno Deploy → Railway

## Why Railway is Better for Discord Role Sync

### ❌ Deno Deploy Limitations
- **Execution time limits**: Functions timeout, cutting off sync operations
- **Serverless isolation**: No persistent state between requests
- **Rate limit state loss**: Adaptive rate limiting resets with each cold start
- **Limited debugging**: Harder to monitor long-running operations
- **Cron restrictions**: Built-in cron has execution time limits

### ✅ Railway Advantages
- **Long-running processes**: No timeout limits for sync operations
- **Persistent state**: Rate limiting and sync state maintained
- **Full control**: Complete control over scheduling and execution
- **Better monitoring**: Persistent logs and real-time monitoring
- **Cost efficiency**: Always-on pricing often cheaper for background tasks

## Migration Steps

### 1. **Set Up Railway Project**

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login to Railway
railway login

# Create new project
railway new

# Connect to your repository
railway link
```

### 2. **Environment Variables Setup**

In Railway dashboard, set these variables:

```env
# Discord Configuration
DISCORD_TOKEN=your_bot_token
DISCORD_APPLICATION_ID=your_app_id
DISCORD_PUBLIC_KEY=your_public_key
DISCORD_GUILD_ID=your_guild_id

# Authentication
SYNC_AUTH_TOKEN=generate_secure_random_token

# Role IDs (optional, defaults in code)
ETHOS_ROLE_EXEMPLARY=role_id_here
ETHOS_ROLE_REPUTABLE=role_id_here
ETHOS_ROLE_NEUTRAL=role_id_here
ETHOS_ROLE_QUESTIONABLE=role_id_here
ETHOS_ROLE_UNTRUSTED=role_id_here

# Service URLs (set after first deployment)
SYNC_SERVICE_URL=https://your-bot.railway.app
```

### 3. **Deploy Main Bot Service**

```bash
# Deploy the main Discord bot
railway up --service discord-bot
```

### 4. **Deploy Cron Manager Service**

```bash
# Deploy the cron manager
railway up --service cron-manager
```

### 5. **Configure Custom Domains (Optional)**

In Railway dashboard:
- Set up custom domain for main bot service
- Update `SYNC_SERVICE_URL` environment variable
- Update Discord webhook URLs if needed

## Optimal Scheduling Strategy

### **Recommended Schedule**
```
Role Sync:         Every 6 hours (00:00, 06:00, 12:00, 18:00)
Validator Check:   Every 2 hours  
Cache Cleanup:     Daily at 3 AM
Health Check:      Every 15 minutes
```

### **Rate Limit Friendly Timing**
- **Off-peak hours**: 12 AM - 6 AM (lowest Discord traffic)
- **Spread operations**: Don't run multiple syncs simultaneously
- **Conservative chunks**: 15-25 users per chunk
- **Extended delays**: 45s between chunks, 5s between users

## Monitoring & Control

### **HTTP Endpoints**
```bash
# Check sync status
curl https://your-bot.railway.app/sync-status

# Check cron jobs
curl https://your-cron.railway.app/cron-status

# Manual sync trigger
curl -X POST https://your-bot.railway.app/trigger-sync \
  -H "Authorization: Bearer $SYNC_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"chunkSize": 15}'

# Reset rate limits if needed
curl -X POST https://your-bot.railway.app/reset-rate-limits \
  -H "Authorization: Bearer $SYNC_AUTH_TOKEN"
```

### **Logs Monitoring**
```bash
# View bot logs
railway logs --service discord-bot

# View cron logs  
railway logs --service cron-manager
```

## Architecture Benefits

### **Two-Service Architecture**
1. **Main Bot Service** (`discord-bot`)
   - Handles Discord interactions
   - Provides HTTP endpoints for sync operations
   - Maintains rate limiting state
   - Always-on for instant Discord responses

2. **Cron Manager Service** (`cron-manager`)
   - Runs scheduled operations
   - Monitors rate limits before starting
   - Handles long-running sync operations
   - Independent scaling and monitoring

### **Persistent State Management**
- Rate limiting state persists across operations
- Adaptive delays improve over time
- Cache state maintained between syncs
- Better error recovery and retry logic

## Performance Optimizations

### **Rate Limit Improvements**
- **Adaptive delays**: Automatically adjusts based on rate limit history
- **Route-specific tracking**: Different delays for different API endpoints
- **Global rate limit detection**: Proactive global rate limit handling
- **Smart recovery**: Gradually reduces delays after successful operations

### **Sync Optimizations**
- **3-day caching**: Avoids redundant API calls
- **Change detection**: Only updates roles when necessary
- **Chunked processing**: Processes users in manageable batches
- **Smart scheduling**: Avoids syncing during high rate limit periods

## Cost Comparison

### **Deno Deploy**
- Free tier: 100K requests/month, 100 GB-hours
- Pro: $20/month for 1M requests, 1000 GB-hours
- **Problem**: Frequent timeouts waste quota

### **Railway**
- Hobby: $5/month per service (2 services = $10/month)
- Pro: $20/month per service with more resources
- **Benefit**: Reliable execution, no wasted resources

## Migration Checklist

- [ ] Set up Railway project and services
- [ ] Configure all environment variables
- [ ] Deploy main bot service
- [ ] Deploy cron manager service
- [ ] Test Discord interactions
- [ ] Test sync endpoints
- [ ] Monitor first scheduled sync
- [ ] Update DNS/webhooks if using custom domains
- [ ] Remove Deno Deploy project
- [ ] Document new endpoints for team

## Emergency Procedures

### **If Rate Limited Severely**
1. Check rate limit status: `GET /sync-status`
2. Stop current operations: `POST /stop-sync`
3. Reset rate limit state: `POST /reset-rate-limits`
4. Wait 10+ minutes for Discord's counters to reset
5. Resume with smaller chunks and longer delays

### **Service Recovery**
```bash
# Restart services if needed
railway restart --service discord-bot
railway restart --service cron-manager

# Check service health
railway status
```

## Long-term Benefits

1. **Reliability**: No more sync interruptions from timeouts
2. **Scalability**: Can handle larger Discord servers
3. **Monitoring**: Better visibility into sync operations
4. **Control**: Fine-tune scheduling based on your server's needs
5. **Cost predictability**: Fixed monthly costs vs unpredictable usage

The Railway migration will solve your rate limiting issues by providing persistent state management and unlimited execution time for sync operations. The two-service architecture ensures your Discord bot remains responsive while background syncing runs reliably. 