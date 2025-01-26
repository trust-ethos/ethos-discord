import os
import discord
from discord import app_commands
from dotenv import load_dotenv
import requests

# Load environment variables
load_dotenv()
DISCORD_TOKEN = os.getenv('DISCORD_TOKEN')
ETHOS_API_KEY = os.getenv('ETHOS_API_KEY')

# Initialize Discord client
class EthosBot(discord.Client):
    def __init__(self):
        super().__init__(intents=discord.Intents.default())
        self.tree = app_commands.CommandTree(self)

    async def setup_hook(self):
        await self.tree.sync()

client = EthosBot()

@client.tree.command(name="ethos", description="Look up Ethos profile for a Twitter user")
async def ethos(interaction: discord.Interaction, twitter_handle: str):
    # Remove @ if present
    twitter_handle = twitter_handle.lstrip('@')
    
    # Defer the response since API call might take time
    await interaction.response.defer()

    try:
        # TODO: Replace with actual Ethos API endpoint and implementation
        # This is a placeholder - you'll need to implement the actual API call
        headers = {'Authorization': f'Bearer {ETHOS_API_KEY}'}
        response = requests.get(
            f'https://api.ethos.com/v1/profile/{twitter_handle}',
            headers=headers
        )
        
        if response.status_code == 200:
            data = response.json()
            # Create an embed with the Ethos profile information
            embed = discord.Embed(
                title=f"Ethos Profile for @{twitter_handle}",
                color=discord.Color.blue()
            )
            # Add fields based on the actual API response
            embed.add_field(name="Ethos Score", value=str(data.get('score', 'N/A')))
            # Add more fields as needed
            
            await interaction.followup.send(embed=embed)
        else:
            await interaction.followup.send(f"Error: Could not fetch Ethos profile for @{twitter_handle}")
            
    except Exception as e:
        await interaction.followup.send(f"An error occurred: {str(e)}")

@client.event
async def on_ready():
    print(f'{client.user} has connected to Discord!')

# Run the bot
client.run(DISCORD_TOKEN) 