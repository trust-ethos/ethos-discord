# Ethos Discord Bot

A Discord bot that fetches and displays Ethos profile information for Twitter and Discord users, built with Deno.

## Prerequisites

1. Install [Deno](https://deno.land/#installation)
2. Set up your environment variables:
   ```bash
   # On macOS/Linux
   export DISCORD_TOKEN=your_discord_bot_token
   export ETHOS_API_KEY=your_ethos_api_key

   # On Windows
   set DISCORD_TOKEN=your_discord_bot_token
   set ETHOS_API_KEY=your_ethos_api_key
   ```

## Running the Bot

   ```bash
deno task start
   ```

This will start the bot with the necessary permissions for network access and environment variables.

## Usage

Use the following slash command in Discord:
- `/ethos [handle]` - Look up Ethos profile using either:
  - Twitter handle (with or without @)
  - Discord username (with or without #)

Examples:
- `/ethos vitalik` - Look up Twitter user @vitalik
- `/ethos @vitalik` - Look up Twitter user @vitalik
- `/ethos discord_user` - Look up Discord user
- `/ethos discord_user#1234` - Look up Discord user with discriminator

## Development

The bot is built using:
- [Deno](https://deno.land/) - A modern runtime for JavaScript and TypeScript

## Testing

To test the bot locally:

```bash
deno run --allow-net test.ts
```

This will simulate Discord interactions for both Twitter and Discord handle lookups. 