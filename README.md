# Ethos Discord Bot

A Discord bot that fetches and displays Ethos profile information for Twitter users.

## Setup

1. Create a `.env` file with your Discord bot token and Ethos API credentials:
```
DISCORD_TOKEN=your_discord_bot_token
ETHOS_API_KEY=your_ethos_api_key
```

2. Install dependencies:
```bash
pip install -r requirements.txt
```

3. Run the bot:
```bash
python bot.py
```

## Usage

Use the following command in Discord:
- `/ethos @twitterhandle` - Look up Ethos profile for a Twitter user 