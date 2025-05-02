# Ethos Discord Bot

A Discord bot that fetches and displays Ethos profile information for Twitter and Discord users, built with Deno.

## Prerequisites

1. Install [Deno](https://deno.land/#installation)
2. Set up your environment variables:
   ```bash
   # On macOS/Linux
   export DISCORD_TOKEN=your_discord_bot_token
   export ETHOS_API_KEY=your_ethos_api_key
   # If using role assignment feature
   export ETHOS_VERIFIED_ROLE_ID=your_discord_role_id

   # On Windows
   set DISCORD_TOKEN=your_discord_bot_token
   set ETHOS_API_KEY=your_ethos_api_key
   # If using role assignment feature
   set ETHOS_VERIFIED_ROLE_ID=your_discord_role_id
   ```

## Running the Bot

   ```bash
deno task start
   ```

This will start the bot with the necessary permissions for network access and environment variables.

## Usage

The bot provides the following slash commands:

- `/ethos @user` - Look up Ethos profile for a Discord user
  - Simply mention a Discord user as a parameter
  - Discord will provide a user selection interface
  - The bot will display the user's display name (the name shown in Discord)
  - Uses the user's Discord avatar in the response
  - Links to their Ethos profile using their primary Ethereum address

- `/ethosx [twitter_handle]` - Look up Ethos profile for a Twitter user
  - Examples:
    - `/ethosx vitalik` - Look up Twitter user @vitalik
    - `/ethosx @vitalik` - Look up Twitter user @vitalik

- `/ethosVerify` - Verify that you have an Ethos profile and get assigned a role
  - No parameters needed - uses your own Discord account
  - Checks if you have an Ethos profile
  - If verified, assigns you the configured role in the server
  - Responds with a confirmation only visible to you

## Development

The bot is built using:
- [Deno](https://deno.land/) - A modern runtime for JavaScript and TypeScript

## Testing

To test the bot locally:

```bash
deno run --allow-net test.ts
```

This will simulate Discord interactions for both commands. 