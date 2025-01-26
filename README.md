# Ethos Discord Bot

A Discord bot that fetches and displays Ethos profile information for Twitter/X users. Built with Deno and Discord's Interactions API.

## Features

- Fetch Ethos profiles using Twitter/X handles
- Display user's Ethos score and reputation level
- Show review statistics and vouch information
- Display the most upvoted review
- Color-coded embeds based on reputation level

## Prerequisites

1. Install [Deno](https://deno.land/#installation)
2. Create a Discord application and bot at the [Discord Developer Portal](https://discord.com/developers/applications)
3. Copy the `.env.example` file to `.env` and fill in your environment variables:
   ```bash
   cp .env.example .env
   ```

## Environment Variables

- `DISCORD_PUBLIC_KEY`: Your Discord application's public key (found in the Developer Portal)
- `DISCORD_APPLICATION_ID`: Your Discord application's ID
- `DISCORD_TOKEN`: Your bot's token (only needed for registering commands)

## Development

1. Start the local development server:
   ```bash
   deno task dev
   ```

2. Use [ngrok](https://ngrok.com/) to expose your local server:
   ```bash
   ngrok http 8000
   ```

3. Update your Discord application's "Interactions Endpoint URL" with your ngrok URL

## Deployment

The bot is designed to be deployed on [Deno Deploy](https://deno.com/deploy):

1. Create a new project on Deno Deploy
2. Link it to your GitHub repository
3. Set the environment variables in the Deno Deploy dashboard
4. Update your Discord application's "Interactions Endpoint URL" with your `.deno.dev` URL

## Commands

- `/ethos @handle` - Look up an Ethos profile for a Twitter/X user
  - Shows Ethos score and reputation level
  - Displays review statistics and vouch information
  - Shows the most upvoted review for the user

## Built With

- [Deno](https://deno.land/) - A modern runtime for JavaScript and TypeScript
- Discord Interactions API - For handling slash commands
- [Ethos API](https://ethos.network) - For fetching reputation data 