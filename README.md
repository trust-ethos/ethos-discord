# Ethos Discord Bot

A Discord bot that fetches and displays Ethos profile information for Twitter users, built with Deno and Harmony.

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
- `/ethos @twitterhandle` - Look up Ethos profile for a Twitter user

## Development

The bot is built using:
- [Deno](https://deno.land/) - A modern runtime for JavaScript and TypeScript
- [Harmony](https://github.com/harmonyland/harmony) - A Discord API library for Deno 