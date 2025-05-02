# Ethos Discord Bot

A Discord bot that fetches and displays Ethos profile information for Twitter and Discord users, built with Deno.

## Prerequisites

1. Install [Deno](https://deno.land/#installation)
2. Set up your environment variables:
   ```bash
   # On macOS/Linux
   export DISCORD_TOKEN=your_discord_bot_token
   export ETHOS_API_KEY=your_ethos_api_key
   
   # For role assignment feature
   export ETHOS_VERIFIED_ROLE_ID=your_verified_role_id
   
   # Score-based roles (optional)
   export ETHOS_ROLE_EXEMPLARY=your_exemplary_role_id     # Score >= 2000
   export ETHOS_ROLE_REPUTABLE=your_reputable_role_id     # Score >= 1600
   export ETHOS_ROLE_NEUTRAL=your_neutral_role_id         # Score >= 1200
   export ETHOS_ROLE_QUESTIONABLE=your_questionable_role_id # Score >= 800
   export ETHOS_ROLE_UNTRUSTED=your_untrusted_role_id     # Score < 800

   # On Windows
   set DISCORD_TOKEN=your_discord_bot_token
   set ETHOS_API_KEY=your_ethos_api_key
   
   # For role assignment feature
   set ETHOS_VERIFIED_ROLE_ID=your_verified_role_id
   
   # Score-based roles (optional)
   set ETHOS_ROLE_EXEMPLARY=your_exemplary_role_id     # Score >= 2000
   set ETHOS_ROLE_REPUTABLE=your_reputable_role_id     # Score >= 1600
   set ETHOS_ROLE_NEUTRAL=your_neutral_role_id         # Score >= 1200
   set ETHOS_ROLE_QUESTIONABLE=your_questionable_role_id # Score >= 800
   set ETHOS_ROLE_UNTRUSTED=your_untrusted_role_id     # Score < 800
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

- `/ethos_verify` - Verify that you have an Ethos profile and get assigned roles
  - No parameters needed - uses your own Discord account
  - Checks if you have an Ethos profile
  - Assigns two roles if verified:
    1. A verified user role (using `ETHOS_VERIFIED_ROLE_ID`)
    2. A score-based role that reflects your Ethos score level
  - Responds with a confirmation only visible to you
  - If you run it again, your roles will be updated based on your current score

## Score-Based Roles

The bot assigns roles based on the following Ethos score brackets:

| Role Name | Score Range | Environment Variable |
|-----------|-------------|---------------------|
| Exemplary | ≥ 2000 | ETHOS_ROLE_EXEMPLARY |
| Reputable | 1600-1999 | ETHOS_ROLE_REPUTABLE |
| Neutral | 1200-1599 | ETHOS_ROLE_NEUTRAL |
| Questionable | 800-1199 | ETHOS_ROLE_QUESTIONABLE |
| Untrusted | < 800 | ETHOS_ROLE_UNTRUSTED |

## Development

The bot is built using:
- [Deno](https://deno.land/) - A modern runtime for JavaScript and TypeScript

## Testing

To test the bot locally:

```bash
deno run --allow-net test.ts
```

This will simulate Discord interactions for both commands. 