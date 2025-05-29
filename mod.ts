// @deno-types="https://deno.land/x/servest/types/react/index.d.ts"
import {
  serve,
  crypto,
  type APIInteraction,
  type APIInteractionResponse,
  InteractionType,
  InteractionResponseType,
  ApplicationCommandType
} from "./deps.ts";

// Load environment variables
const PUBLIC_KEY = Deno.env.get("DISCORD_PUBLIC_KEY");
const APPLICATION_ID = Deno.env.get("DISCORD_APPLICATION_ID");
// Hardcoded role IDs
const ETHOS_VERIFIED_ROLE_ID = "1330927513056186501"; // "verified" role
// Validator role ID
const ETHOS_VALIDATOR_ROLE_ID = "1377477396759842936";
// Score-based role IDs
const ETHOS_ROLE_EXEMPLARY = Deno.env.get("ETHOS_ROLE_EXEMPLARY") || "1253205892917231677"; // Score >= 2000
const ETHOS_ROLE_REPUTABLE = Deno.env.get("ETHOS_ROLE_REPUTABLE") || "1253206005169258537"; // Score >= 1600
const ETHOS_ROLE_NEUTRAL = Deno.env.get("ETHOS_ROLE_NEUTRAL") || "1253206143182831637"; // Score >= 1200
const ETHOS_ROLE_QUESTIONABLE = Deno.env.get("ETHOS_ROLE_QUESTIONABLE") || "1253206252306305024"; // Score >= 800
const ETHOS_ROLE_UNTRUSTED = Deno.env.get("ETHOS_ROLE_UNTRUSTED") || "1253206385877975043"; // Score < 800

if (!PUBLIC_KEY || !APPLICATION_ID) {
  console.error("Environment variables check failed:");
  console.error("DISCORD_PUBLIC_KEY:", PUBLIC_KEY ? "set" : "missing");
  console.error("DISCORD_APPLICATION_ID:", APPLICATION_ID ? "set" : "missing");
  // Don't throw, just log the error
}

// Helper function to check if a handle is likely a Discord handle
function isDiscordHandle(handle: string): boolean {
  // Discord handles typically don't start with @ and may contain a #
  return !handle.startsWith('@') || handle.includes('#');
}

// Function to check if a Discord user has an Ethos profile
async function checkUserHasEthosProfile(userId: string): Promise<boolean> {
  try {
    console.log("Checking if Discord user with ID has an Ethos profile:", userId);
    
    // Make sure we're just using the raw ID without any @ symbol
    const cleanUserId = userId.replace('@', '').replace('<', '').replace('>', '');
    console.log("Clean User ID:", cleanUserId);
    
    // Use the Ethos API with the Discord ID - ensure proper format
    const userkey = `service:discord:${cleanUserId}`;
    
    // First fetch the user's addresses to see if they have an Ethos profile
    const profileResponse = await fetch(`https://api.ethos.network/api/v1/score/${userkey}`);
    
    // If we get a 200 OK response, the user has a profile
    return profileResponse.ok;
  } catch (error) {
    console.error("Error checking if user has Ethos profile:", error);
    return false;
  }
}

// Function to check if a user owns a validator NFT
async function checkUserOwnsValidator(userId: string): Promise<boolean> {
  try {
    console.log("Checking if Discord user owns validator NFT:", userId);
    
    // Make sure we're just using the raw ID without any @ symbol
    const cleanUserId = userId.replace('@', '').replace('<', '').replace('>', '');
    const userkey = `service:discord:${cleanUserId}`;
    
    // Check if user owns a validator using the v2 API endpoint
    const validatorResponse = await fetch(`https://api.ethos.network/api/v2/nfts/user/${userkey}/owns-validator`);
    
    if (!validatorResponse.ok) {
      console.log(`Validator check failed with status: ${validatorResponse.status}`);
      return false;
    }
    
    const validatorData = await validatorResponse.json();
    console.log("Validator API Response:", JSON.stringify(validatorData, null, 2));
    
    // The API returns an array of validator NFTs. If the array has any items, the user owns a validator
    return Array.isArray(validatorData) && validatorData.length > 0;
  } catch (error) {
    console.error("Error checking if user owns validator:", error);
    return false;
  }
}

// Add this utility function for Discord API calls with rate limit handling
async function discordApiCall(url: string, options: RequestInit): Promise<Response> {
  const DISCORD_TOKEN_VAL = Deno.env.get("DISCORD_TOKEN");
  if (!DISCORD_TOKEN_VAL) {
    throw new Error("Missing Discord token");
  }

  // Set up headers
  const headers = {
    "Authorization": `Bot ${DISCORD_TOKEN_VAL}`,
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  // Maximum number of retries
  const MAX_RETRIES = 3;
  let retries = 0;

  while (retries < MAX_RETRIES) {
    try {
      const response = await fetch(url, {
        ...options,
        headers
      });

      // If rate limited, wait and retry
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get("Retry-After") || "1");
        console.log(`Rate limited. Waiting ${retryAfter}s before retrying...`);
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        retries++;
        continue;
      }

      return response;
    } catch (error) {
      console.error("Error making Discord API call:", error);
      throw error;
    }
  }

  throw new Error(`Failed after ${MAX_RETRIES} retries due to rate limiting`);
}

// Update assignRoleToUser to use the new function
async function assignRoleToUser(guildId: string, userId: string, roleId: string) {
  try {
    const url = `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`;
    
    const response = await discordApiCall(url, {
      method: "PUT"
    });
    
    if (!response.ok) {
      const errorData = await response.text();
      console.error(`Failed to assign role: ${response.status} ${errorData}`);
      return { 
        success: false, 
        error: `Failed to assign role: ${response.status}` 
      };
    }
    
    return { success: true };
  } catch (error) {
    console.error("Error assigning role:", error);
    return { 
      success: false, 
      error: `Error assigning role: ${error}` 
    };
  }
}

// Function to fetch Ethos profile by Discord user ID
async function fetchEthosProfileByDiscord(userId: string, discordAvatarUrl?: string) {
  try {
    console.log("Looking up Discord user with ID:", userId);
    
    // Make sure we're just using the raw ID without any @ symbol
    const cleanUserId = userId.replace('@', '').replace('<', '').replace('>', '');
    console.log("Clean User ID:", cleanUserId);
    
    // Use the Ethos API with the Discord ID - ensure proper format
    const userkey = `service:discord:${cleanUserId}`;
    
    // First fetch the user's addresses to get their primary Ethereum address
    const addressResponse = await fetch(`https://api.ethos.network/api/v1/addresses/${userkey}`);
    const addressData = await addressResponse.json();
    console.log("Address API Response:", JSON.stringify(addressData, null, 2));
    
    let primaryAddress = null;
    if (addressData.ok && addressData.data?.primaryAddress) {
      primaryAddress = addressData.data.primaryAddress;
      // Check if it's the zero address (0x0000...)
      if (primaryAddress === "0x0000000000000000000000000000000000000000") {
        primaryAddress = null;
      }
    }
    
    console.log("Primary Address:", primaryAddress);
    
    // Fetch profile score and user statistics using the API endpoint
    const [profileResponse, userStatsResponse, topReviewResponse] = await Promise.all([
      fetch(`https://api.ethos.network/api/v1/score/${userkey}`),
      fetch(`https://api.ethos.network/api/v1/users/${userkey}/stats`),
      fetch(`https://api.ethos.network/api/v1/activities/unified`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          target: userkey,
          direction: "subject",
          orderBy: {
            field: "votes",
            direction: "desc"
          },
          filter: ["review"],
          excludeHistorical: true,
          pagination: {
            offsets: {},
            limit: 1
          }
        })
      })
    ]);
    
    if (!profileResponse.ok) {
      if (profileResponse.status === 404) {
        return { error: `No Ethos profile found for Discord user with ID '${cleanUserId}'. They either don't have a profile or haven't connected Discord to their Ethos account.` };
      }
      return { error: "Failed to fetch profile. Please try again later." };
    }

    const profileData = await profileResponse.json();
    console.log("Profile API Response:", JSON.stringify(profileData, null, 2));

    if (!profileData.ok || !profileData.data) {
      return { error: "This profile hasn't been indexed by Ethos yet. Please try again later." };
    }

    const userStats = await userStatsResponse.json();
    console.log("User Stats API Response:", JSON.stringify(userStats, null, 2));
    
    const topReviewResponseData = await topReviewResponse.json();
    console.log("Top Review Response:", JSON.stringify(topReviewResponseData, null, 2));
    
    const topReviewData = topReviewResponseData.ok && topReviewResponseData.data?.values?.[0]?.data;

    // Extract review stats from the new unified response
    const totalReviews = userStats.ok ? userStats.data?.reviews?.received || 0 : 0;
    const positiveReviewCount = userStats.ok ? userStats.data?.reviews?.positiveReviewCount || 0 : 0;
    const negativeReviewCount = userStats.ok ? userStats.data?.reviews?.negativeReviewCount || 0 : 0;
    const positivePercentage = userStats.ok ? userStats.data?.reviews?.positiveReviewPercentage || 0 : 0;
    
    // Extract vouch stats from the new unified response
    const vouchCount = userStats.ok ? userStats.data?.vouches?.count?.received || 0 : 0;
    const vouchBalance = userStats.ok ? Number(userStats.data?.vouches?.balance?.received || 0).toFixed(2) : "0.00";
    const mutualVouches = userStats.ok ? userStats.data?.vouches?.count?.mutual || 0 : 0;

    const scoreData = profileData.data;
    const elements = scoreData.elements || {};

    return {
      score: scoreData.score,
      handle: cleanUserId, // Use the clean user ID as the handle
      userId: cleanUserId,
      avatar: discordAvatarUrl || scoreData.avatar || "https://cdn.discordapp.com/embed/avatars/0.png", // Use Discord avatar if provided
      name: scoreData.name || `Discord User ${cleanUserId}`,
      service: 'discord',
      primaryAddress,
      elements: {
        accountAge: elements["Discord Account Age"]?.raw,
        ethAge: elements["Ethereum Address Age"]?.raw,
        vouchCount,
        vouchBalance,
        totalReviews,
        positivePercentage,
        mutualVouches
      },
      topReview: topReviewData ? {
        comment: topReviewData.comment,
        score: topReviewData.score,
        upvotes: topReviewResponseData.data.values[0].votes.upvotes,
        authorName: topReviewResponseData.data.values[0].author.name
      } : null
    };
  } catch (error) {
    console.error("Error fetching Ethos profile by Discord:", error);
    return { error: "Something went wrong while fetching the profile. Please try again later." };
  }
}

// Function to fetch Ethos profile by Twitter handle
async function fetchEthosProfileByTwitter(handle: string) {
  try {
    // Format handle for x.com service
    const formattedHandle = handle.replace('@', '');
    
    // First fetch Twitter ID
    const twitterResponse = await fetch(`https://api.ethos.network/api/twitter/user/?username=${formattedHandle}`);
    if (!twitterResponse.ok) {
      if (twitterResponse.status === 404) {
        return { error: `Twitter handle @${formattedHandle} not found` };
      }
      return { error: "Failed to fetch Twitter info. Please try again later." };
    }

    const twitterData = await twitterResponse.json();
    console.log("Twitter API Response:", JSON.stringify(twitterData, null, 2));

    if (!twitterData.ok || !twitterData.data?.id) {
      return { error: "Could not find Twitter ID for this handle" };
    }

    const twitterId = twitterData.data.id;
    const userkey = `service:x.com:${twitterId}`;
    
    // Fetch profile score and user statistics using the new API endpoint
    const [profileResponse, userStatsResponse, topReviewResponse] = await Promise.all([
      fetch(`https://api.ethos.network/api/v1/score/${userkey}`),
      fetch(`https://api.ethos.network/api/v1/users/${userkey}/stats`),
      fetch(`https://api.ethos.network/api/v1/activities/unified`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          target: userkey,
          direction: "subject",
          orderBy: {
            field: "votes",
            direction: "desc"
          },
          filter: ["review"],
          excludeHistorical: true,
          pagination: {
            offsets: {},
            limit: 1
          }
        })
      })
    ]);
    
    if (!profileResponse.ok) {
      if (profileResponse.status === 404) {
        return { error: `No Ethos profile found for @${formattedHandle}.` };
      }
      return { error: "Failed to fetch profile. Please try again later." };
    }

    const profileData = await profileResponse.json();
    console.log("Profile API Response:", JSON.stringify(profileData, null, 2));

    if (!profileData.ok || !profileData.data) {
      return { error: "This profile hasn't been indexed by Ethos yet. Please try again later." };
    }

    const userStats = await userStatsResponse.json();
    console.log("User Stats API Response:", JSON.stringify(userStats, null, 2));
    
    const topReviewResponseData = await topReviewResponse.json();
    console.log("Top Review Response:", JSON.stringify(topReviewResponseData, null, 2));
    
    const topReviewData = topReviewResponseData.ok && topReviewResponseData.data?.values?.[0]?.data;

    // Extract review stats from the new unified response
    const totalReviews = userStats.ok ? userStats.data?.reviews?.received || 0 : 0;
    const positiveReviewCount = userStats.ok ? userStats.data?.reviews?.positiveReviewCount || 0 : 0;
    const negativeReviewCount = userStats.ok ? userStats.data?.reviews?.negativeReviewCount || 0 : 0;
    const positivePercentage = userStats.ok ? userStats.data?.reviews?.positiveReviewPercentage || 0 : 0;
    
    // Extract vouch stats from the new unified response
    const vouchCount = userStats.ok ? userStats.data?.vouches?.count?.received || 0 : 0;
    const vouchBalance = userStats.ok ? Number(userStats.data?.vouches?.balance?.received || 0).toFixed(2) : "0.00";
    const mutualVouches = userStats.ok ? userStats.data?.vouches?.count?.mutual || 0 : 0;

    const scoreData = profileData.data;
    const elements = scoreData.elements || {};

    return {
      score: scoreData.score,
      handle: formattedHandle,
      twitterId,
      avatar: twitterData.data.avatar,
      name: twitterData.data.name,
      service: 'twitter',
      elements: {
        accountAge: elements["Twitter Account Age"]?.raw,
        ethAge: elements["Ethereum Address Age"]?.raw,
        vouchCount,
        vouchBalance,
        totalReviews,
        positivePercentage,
        mutualVouches
      },
      topReview: topReviewData ? {
        comment: topReviewData.comment,
        score: topReviewData.score,
        upvotes: topReviewResponseData.data.values[0].votes.upvotes,
        authorName: topReviewResponseData.data.values[0].author.name
      } : null
    };
  } catch (error) {
    console.error("Error fetching Ethos profile by Twitter:", error);
    return { error: "Something went wrong while fetching the profile. Please try again later." };
  }
}

// Function to fetch Ethos profile
async function fetchEthosProfile(handle: string) {
  // Detect if handle is a Discord handle or Twitter handle
  if (isDiscordHandle(handle)) {
    return fetchEthosProfileByDiscord(handle);
  } else {
    return fetchEthosProfileByTwitter(handle);
  }
}

// Helper function to convert hex to Uint8Array
function hexToUint8Array(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []);
}

// Verify the request is from Discord
async function verifyRequest(request: Request): Promise<APIInteraction | null> {
  console.log("Received request:", request.method);
  console.log("Headers:", Object.fromEntries(request.headers.entries()));
  
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  
  if (!signature || !timestamp) {
    console.error("Missing signature or timestamp");
    console.error("signature:", signature);
    console.error("timestamp:", timestamp);
    return null;
  }
  
  const body = await request.text();
  console.log("Request body:", body);
  
  try {
    console.log("Using public key:", PUBLIC_KEY);

    const key = await crypto.subtle.importKey(
      "raw",
      hexToUint8Array(PUBLIC_KEY || ''),
      {
        name: "Ed25519"
      },
      false,
      ["verify"]
    );

    const signatureUint8 = hexToUint8Array(signature);
    const timestampAndBody = new TextEncoder().encode(timestamp + body);
    
    console.log("Signature length:", signatureUint8.length);
    console.log("Message length:", timestampAndBody.length);

    const isValid = await crypto.subtle.verify(
      {
        name: "Ed25519"
      },
      key,
      signatureUint8,
      timestampAndBody
    );
    
    console.log("Signature verification result:", isValid);
    
    if (!isValid) {
      console.error("Invalid signature");
      return null;
    }
    
    return JSON.parse(body);
  } catch (error) {
    console.error("Error verifying request:", error);
    return null;
  }
}

// Function to get role ID based on score
function getRoleIdForScore(score: number): string {
  if (score >= 2000) return ETHOS_ROLE_EXEMPLARY;
  if (score >= 1600) return ETHOS_ROLE_REPUTABLE;
  if (score >= 1200) return ETHOS_ROLE_NEUTRAL;
  if (score >= 800) return ETHOS_ROLE_QUESTIONABLE;
  return ETHOS_ROLE_UNTRUSTED;
}

// Function to get role name based on score
function getRoleNameForScore(score: number): string {
  if (score >= 2000) return "Exemplary";
  if (score >= 1600) return "Reputable";
  if (score >= 1200) return "Neutral";
  if (score >= 800) return "Questionable";
  return "Untrusted";
}

// Function to remove all Ethos roles from a user more efficiently
async function removeAllEthosRoles(guildId: string, userId: string): Promise<boolean> {
  const allRoles = [
    ETHOS_VERIFIED_ROLE_ID,
    ETHOS_VALIDATOR_ROLE_ID,
    ETHOS_ROLE_EXEMPLARY,
    ETHOS_ROLE_REPUTABLE,
    ETHOS_ROLE_NEUTRAL,
    ETHOS_ROLE_QUESTIONABLE,
    ETHOS_ROLE_UNTRUSTED
  ];
  
  try {
    // First fetch user's current roles
    const url = `https://discord.com/api/v10/guilds/${guildId}/members/${userId}`;
    
    const response = await discordApiCall(url, {
      method: "GET"
    });
    
    if (!response.ok) {
      console.error(`Failed to fetch user: ${response.status}`);
      return false;
    }
    
    const userData = await response.json();
    const userRoles = userData.roles || [];
    
    console.log(`User has ${userRoles.length} roles`);
    
    // Check which Ethos roles the user has
    const rolesToRemove = allRoles.filter(roleId => userRoles.includes(roleId));
    
    console.log(`Found ${rolesToRemove.length} Ethos roles to remove`);
    
    // If user doesn't have any Ethos roles, skip removal
    if (rolesToRemove.length === 0) {
      console.log("User doesn't have any Ethos roles to remove");
      return true;
    }
    
    // Remove roles one by one, but with rate limit handling
    for (const roleId of rolesToRemove) {
      const removeUrl = `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`;
      const removeResponse = await discordApiCall(removeUrl, {
        method: "DELETE"
      });
      
      if (!removeResponse.ok) {
        console.error(`Failed to remove role ${roleId}: ${removeResponse.status}`);
        // Continue with other roles even if one fails
      } else {
        console.log(`Successfully removed role ${roleId}`);
      }
      
      // Add a small delay between requests to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    
    return true;
  } catch (error) {
    console.error("Error removing roles:", error);
    return false;
  }
}

// Handle Discord interactions
async function handleInteraction(interaction: APIInteraction): Promise<APIInteractionResponse> {
  switch (interaction.type) {
    // Respond to ping from Discord
    case InteractionType.Ping:
      return {
        type: InteractionResponseType.Pong
      };
    
    // Handle slash commands
    case InteractionType.ApplicationCommand: {
      const commandName = interaction.data?.name;

      // Handle ethos_verify command (verify user and assign role)
      if (commandName === "ethos_verify") {
        // Get the user's ID directly from the interaction
        const userId = interaction.member?.user?.id;
        const guildId = interaction.guild_id;
        
        if (!userId) {
          return {
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
              content: "Unable to identify your Discord account. Please try again.",
              flags: 64 // Ephemeral message (only visible to the user)
            }
          };
        }
        
        if (!guildId) {
          return {
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
              content: "This command can only be used in a server.",
              flags: 64 // Ephemeral message
            }
          };
        }
        
        // First, remove any existing Ethos roles
        const rolesRemoved = await removeAllEthosRoles(guildId, userId);
        if (!rolesRemoved) {
          return {
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
              content: "Failed to update roles. Please try again later.",
              flags: 64 // Ephemeral message
            }
          };
        }
        
        // Get user profile to check score
        const profile = await fetchEthosProfileByDiscord(userId);
        
        if ("error" in profile) {
          return {
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
              content: profile.error,
              flags: 64 // Ephemeral message
            }
          };
        }
        
        console.log(`User ${userId} has Ethos score: ${profile.score}`);
        
        // Check if the user has an actual Ethos profile (not just a default value)
        // Users without profiles should not be assigned roles
        // We'll consider a profile valid only if it has a score and some interactions
        // like reviews, vouches, or a claimed wallet address
        const hasInteractions = 
          (profile.elements?.totalReviews > 0) || 
          (profile.elements?.vouchCount > 0) || 
          profile.primaryAddress;
          
        // Check for exactly 1200 score with no interactions, which appears to be a default value
        const isDefaultProfile = profile.score === 1200 && !hasInteractions;
          
        if (profile.score === undefined || typeof profile.score !== 'number' || !hasInteractions || isDefaultProfile) {
          console.log(`User ${userId} has default/empty profile: score=${profile.score}, reviews=${profile.elements?.totalReviews}, vouches=${profile.elements?.vouchCount}, wallet=${profile.primaryAddress ? 'yes' : 'no'}`);
          
          return {
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
              content: "You don't have an Ethos profile OR you haven't connected Discord to your Ethos account yet. Ethos users can connect their Discord account at https://app.ethos.network/profile/settings?tab=social",
              flags: 64 // Ephemeral message
            }
          };
        }
        
        // Assign the verified role
        const verifiedResult = await assignRoleToUser(guildId, userId, ETHOS_VERIFIED_ROLE_ID);
        
        if (!verifiedResult.success) {
          return {
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
              content: `Verification failed: ${verifiedResult.error}`,
              flags: 64 // Ephemeral message
            }
          };
        }
        
        // Check if user owns a validator NFT and assign validator role
        const ownsValidator = await checkUserOwnsValidator(userId);
        let validatorResult: { success: boolean; error?: string } = { success: true };
        
        if (ownsValidator) {
          console.log(`User ${userId} owns a validator NFT, assigning Validator role`);
          validatorResult = await assignRoleToUser(guildId, userId, ETHOS_VALIDATOR_ROLE_ID);
        } else {
          console.log(`User ${userId} does not own a validator NFT`);
        }
        
        // Assign score-based role
        const scoreRoleId = getRoleIdForScore(profile.score);
        const roleName = getRoleNameForScore(profile.score);
        
        console.log(`Assigning score role: ${roleName} (ID: ${scoreRoleId}) for score ${profile.score}`);
        
        const scoreResult = await assignRoleToUser(guildId, userId, scoreRoleId);
        
        // Create response message
        let responseMessage = "✅ Verification successful! ";
        
        if (scoreResult.success) {
          responseMessage += `You've been assigned the "${roleName}" role with a score of ${profile.score}.`;
        } else {
          responseMessage += `You've been verified but there was an error assigning your score role: ${scoreResult.error}`;
          console.error(`Failed to assign score role ${roleName} (${scoreRoleId}) to user ${userId}: ${scoreResult.error}`);
        }
        
        // Add validator role info to response
        if (ownsValidator) {
          if (validatorResult.success) {
            responseMessage += " You've also been assigned the \"Validator\" role.";
          } else {
            responseMessage += ` There was an error assigning your Validator role: ${validatorResult.error}`;
            console.error(`Failed to assign Validator role to user ${userId}: ${validatorResult.error}`);
          }
        }
        
        return {
          type: InteractionResponseType.ChannelMessageWithSource,
          data: {
            content: responseMessage,
            flags: 64 // Ephemeral message
          }
        };
      }
      
      // Handle ethos command (Discord profiles)
      else if (commandName === "ethos") {
        // With a User type option, Discord will automatically provide the user ID
        const userId = interaction.data.options?.[0].value?.toString();
        if (!userId) {
          return {
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
              content: "Please mention a Discord user!",
              flags: 64 // Ephemeral
            }
          };
        }

        console.log("Discord user ID from interaction:", userId);
        
        // Get the Discord user information
        const userData = interaction.data.resolved?.users?.[userId];
        const username = userData?.username || "Unknown User";
        // Use display name (global_name) if available, otherwise use username
        const displayName = userData?.global_name || username;
        
        console.log("Discord username:", username);
        console.log("Discord display name:", displayName);
        
        // Get user's Discord avatar URL if available
        let avatarUrl: string | undefined = undefined;
        if (userData?.avatar) {
          // Discord avatar format: https://cdn.discordapp.com/avatars/{user.id}/{user.avatar}.png
          avatarUrl = `https://cdn.discordapp.com/avatars/${userId}/${userData.avatar}.png`;
        }
        
        const profile = await fetchEthosProfileByDiscord(userId, avatarUrl);
        
        if ("error" in profile) {
          return {
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
              content: profile.error,
              flags: 64 // Ephemeral
            }
          };
        }

        // Display the display name in the title
        const title = `Ethos profile for ${displayName}`;
        
        // Use the primary address for the profile URL if available, otherwise fall back to Discord
        let profileUrl;
        if (profile.primaryAddress) {
          profileUrl = `https://app.ethos.network/profile/${profile.primaryAddress}?src=discord-agent`;
        } else {
          profileUrl = `https://app.ethos.network/profile/discord/${profile.userId}?src=discord-agent`;
        }

        return {
          type: InteractionResponseType.ChannelMessageWithSource,
          data: {
            embeds: [{
              title,
              url: profileUrl,
              description: `${displayName} is considered **${getScoreLabel(profile.score)}**.`,
              color: getScoreColor(profile.score),
              thumbnail: {
                // Use Discord avatar if available, otherwise use Ethos avatar or default
                url: avatarUrl || profile.avatar || "https://cdn.discordapp.com/embed/avatars/0.png"
              },
              fields: [
                {
                  name: "Ethos score",
                  value: String(profile.score ?? "N/A"),
                  inline: true
                },
                {
                  name: "Reviews",
                  value: `${profile.elements?.totalReviews} (${profile.elements?.positivePercentage?.toFixed(2)}% positive)`,
                  inline: true
                },
                {
                  name: "Vouched",
                  value: `${profile.elements?.vouchBalance}e (${profile.elements?.vouchCount} vouchers)`,
                  inline: true
                },
                ...(profile.topReview ? [{
                  name: "Most upvoted review",
                  value: `*"${profile.topReview.comment}"* - ${profile.topReview.authorName} (${profile.topReview.upvotes} upvotes)`,
                  inline: false
                }] : [])
              ],
              footer: {
                text: "Data from https://app.ethos.network"
              },
              timestamp: new Date().toISOString()
            }]
          }
        };
      }
      
      // Handle ethosx command (Twitter profiles)
      else if (commandName === "ethosx") {
        const twitterHandle = interaction.data.options?.[0].value?.toString();
        if (!twitterHandle) {
          return {
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
              content: "Please provide a Twitter handle!",
              flags: 64 // Ephemeral
            }
          };
        }

        const profile = await fetchEthosProfileByTwitter(twitterHandle);
        
        if ("error" in profile) {
          return {
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
              content: profile.error,
              flags: 64 // Ephemeral
            }
          };
        }

        const title = `Ethos profile for @${profile.handle}`;
        const profileUrl = `https://app.ethos.network/profile/x/${profile.handle}?src=discord-agent`;

        return {
          type: InteractionResponseType.ChannelMessageWithSource,
          data: {
            embeds: [{
              title,
              url: profileUrl,
              description: `${profile.name} is considered **${getScoreLabel(profile.score)}**.`,
              color: getScoreColor(profile.score),
              thumbnail: {
                url: profile.avatar
              },
              fields: [
                {
                  name: "Ethos score",
                  value: String(profile.score ?? "N/A"),
                  inline: true
                },
                {
                  name: "Reviews",
                  value: `${profile.elements?.totalReviews} (${profile.elements?.positivePercentage?.toFixed(2)}% positive)`,
                  inline: true
                },
                {
                  name: "Vouched",
                  value: `${profile.elements?.vouchBalance}e (${profile.elements?.vouchCount} vouchers)`,
                  inline: true
                },
                ...(profile.topReview ? [{
                  name: "Most upvoted review",
                  value: `*"${profile.topReview.comment}"* - ${profile.topReview.authorName} (${profile.topReview.upvotes} upvotes)`,
                  inline: false
                }] : [])
              ],
              footer: {
                text: "Data from https://app.ethos.network"
              },
              timestamp: new Date().toISOString()
            }]
          }
        };
      }
      
      // Handle ethos_sync command (manual role synchronization)
      else if (commandName === "ethos_sync") {
        const guildId = interaction.guild_id;
        
        if (!guildId) {
          return {
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
              content: "This command can only be used in a server.",
              flags: 64 // Ephemeral message
            }
          };
        }
        
        // Check if user has permission to run sync (you might want to add permission checks here)
        // For now, we'll allow anyone to trigger a sync
        
        // Start the sync asynchronously and respond immediately
        performManualSync(guildId).catch(error => {
          console.error("Error in manual sync:", error);
        });
        
        return {
          type: InteractionResponseType.ChannelMessageWithSource,
          data: {
            content: "🔄 Manual role synchronization started! This may take a few minutes. Check the logs for progress.",
            flags: 64 // Ephemeral message
          }
        };
      }
      
      // Handle ethos_sync_stop command (stop running sync)
      else if (commandName === "ethos_sync_stop") {
        const stopped = stopSync();
        
        return {
          type: InteractionResponseType.ChannelMessageWithSource,
          data: {
            content: stopped ? 
              "🛑 Stop signal sent to running sync process. It will stop after the current user." :
              "ℹ️ No sync is currently running.",
            flags: 64 // Ephemeral message
          }
        };
      }
      
      // Handle ethos_sync_status command (check sync status)
      else if (commandName === "ethos_sync_status") {
        const status = getSyncStatus();
        
        let statusMessage = "";
        if (status.isRunning) {
          const minutes = Math.floor(status.duration / 60000);
          const seconds = Math.floor((status.duration % 60000) / 1000);
          statusMessage = `🔄 **Sync in progress**\n` +
            `⏱️ Duration: ${minutes}m ${seconds}s\n` +
            `👥 Progress: ${status.processedUsers}/${status.totalUsers} users\n` +
            `🎯 Guild: ${status.currentGuild}\n` +
            `${status.shouldStop ? "🛑 Stop signal sent" : ""}`;
        } else {
          statusMessage = "✅ No sync currently running";
        }
        
        return {
          type: InteractionResponseType.ChannelMessageWithSource,
          data: {
            content: statusMessage,
            flags: 64 // Ephemeral message
          }
        };
      }
      
      // Unknown command
      else {
        return {
          type: InteractionResponseType.ChannelMessageWithSource,
          data: {
            content: "Unknown command",
            flags: 64 // Ephemeral
          }
        };
      }
    }

    default:
      return {
        type: InteractionResponseType.ChannelMessageWithSource,
        data: {
          content: "Unsupported interaction type",
          flags: 64 // Ephemeral
        }
      };
  }
}

function getScoreLabel(score: number): string {
  if (score >= 2000) return "exemplary";
  if (score >= 1600) return "reputable";
  if (score >= 1200) return "neutral";
  if (score >= 800) return "questionable";
  return "untrusted";
}

function getScoreColor(score: number): number {
  if (score >= 2000) return 0x127F31; // Exemplary - Green
  if (score >= 1600) return 0x2E7BC3; // Reputable - Blue
  if (score >= 1200) return 0xC1C0B6; // Neutral - Gray
  if (score >= 800) return 0xCC9A1A;  // Questionable - Yellow
  return 0xB72B38; // Untrusted - Red
}

// Start HTTP server
serve(async (req) => {
  const url = new URL(req.url);
  
  // Handle role sync trigger endpoint
  if (url.pathname === "/trigger-sync" && req.method === "POST") {
    try {
      // Optional: Add authentication here
      const authHeader = req.headers.get("Authorization");
      const expectedAuth = Deno.env.get("SYNC_AUTH_TOKEN");
      
      if (expectedAuth && authHeader !== `Bearer ${expectedAuth}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      
      // Get guild ID from request body or use default
      let guildId: string | undefined;
      try {
        const body = await req.json();
        guildId = body.guildId;
      } catch {
        // No body or invalid JSON, use default guild ID
      }
      
      // Trigger the sync asynchronously
      triggerRoleSync(guildId).catch(error => {
        console.error("Error in triggered sync:", error);
      });
      
      return new Response(JSON.stringify({
        success: true,
        message: "Role synchronization triggered",
        guildId: guildId || Deno.env.get("DISCORD_GUILD_ID") || "default"
      }), {
        headers: { "Content-Type": "application/json" }
      });
      
    } catch (error) {
      console.error("Error triggering sync:", error);
      return new Response(JSON.stringify({
        success: false,
        error: "Failed to trigger sync"
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
  
  // Handle sync stop endpoint
  if (url.pathname === "/stop-sync" && req.method === "POST") {
    try {
      // Optional: Add authentication here
      const authHeader = req.headers.get("Authorization");
      const expectedAuth = Deno.env.get("SYNC_AUTH_TOKEN");
      
      if (expectedAuth && authHeader !== `Bearer ${expectedAuth}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      
      const stopped = stopSync();
      
      return new Response(JSON.stringify({
        success: true,
        message: stopped ? "Stop signal sent to running sync" : "No sync currently running",
        wasStopped: stopped
      }), {
        headers: { "Content-Type": "application/json" }
      });
      
    } catch (error) {
      console.error("Error stopping sync:", error);
      return new Response(JSON.stringify({
        success: false,
        error: "Failed to stop sync"
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
  
  // Handle sync status endpoint
  if (url.pathname === "/sync-status" && req.method === "GET") {
    try {
      const status = getSyncStatus();
      
      return new Response(JSON.stringify({
        success: true,
        status
      }), {
        headers: { "Content-Type": "application/json" }
      });
      
    } catch (error) {
      console.error("Error getting sync status:", error);
      return new Response(JSON.stringify({
        success: false,
        error: "Failed to get sync status"
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
  
  // Handle Discord interactions
  if (req.method === "POST" && url.pathname === "/") {
    try {
      const interaction = await verifyRequest(req);
      if (!interaction) {
        return new Response("Invalid request signature", { status: 401 });
      }

      const response = await handleInteraction(interaction);
      return new Response(JSON.stringify(response), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (error) {
      console.error("Error handling request:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  // Health check endpoint
  if (url.pathname === "/health" && req.method === "GET") {
    return new Response(JSON.stringify({
      status: "healthy",
      timestamp: new Date().toISOString()
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  return new Response("OK", { status: 200 });
});

// ===== AUTOMATED ROLE SYNCHRONIZATION =====

// Global sync state management
let syncStatus = {
  isRunning: false,
  shouldStop: false,
  currentGuild: null as string | null,
  startTime: null as number | null,
  processedUsers: 0,
  totalUsers: 0
};

// Function to stop the current sync
export function stopSync(): boolean {
  if (syncStatus.isRunning) {
    console.log("Stop signal sent to running sync process");
    syncStatus.shouldStop = true;
    return true;
  }
  return false;
}

// Function to get sync status
export function getSyncStatus() {
  return {
    ...syncStatus,
    duration: syncStatus.startTime ? Date.now() - syncStatus.startTime : 0
  };
}

// Function to reset sync status
function resetSyncStatus() {
  syncStatus = {
    isRunning: false,
    shouldStop: false,
    currentGuild: null,
    startTime: null,
    processedUsers: 0,
    totalUsers: 0
  };
}

// Function to get all verified members from a guild
async function getVerifiedMembers(guildId: string): Promise<string[]> {
  try {
    console.log("Fetching verified members from guild:", guildId);
    
    // Get all members with the verified role
    const url = `https://discord.com/api/v10/guilds/${guildId}/members?limit=1000`;
    
    const response = await discordApiCall(url, {
      method: "GET"
    });
    
    if (!response.ok) {
      console.error(`Failed to fetch guild members: ${response.status}`);
      return [];
    }
    
    const members = await response.json();
    
    // Filter members who have the verified role
    const verifiedMembers = members
      .filter((member: any) => member.roles.includes(ETHOS_VERIFIED_ROLE_ID))
      .map((member: any) => member.user.id);
    
    console.log(`Found ${verifiedMembers.length} verified members`);
    return verifiedMembers;
  } catch (error) {
    console.error("Error fetching verified members:", error);
    return [];
  }
}

// Function to get current Ethos roles for a user
function getCurrentEthosRoles(userRoles: string[]): string[] {
  const ethosRoles = [
    ETHOS_VERIFIED_ROLE_ID,
    ETHOS_VALIDATOR_ROLE_ID,
    ETHOS_ROLE_EXEMPLARY,
    ETHOS_ROLE_REPUTABLE,
    ETHOS_ROLE_NEUTRAL,
    ETHOS_ROLE_QUESTIONABLE,
    ETHOS_ROLE_UNTRUSTED
  ];
  
  return userRoles.filter(roleId => ethosRoles.includes(roleId));
}

// Function to get expected roles based on Ethos profile
function getExpectedRoles(score: number, hasValidator: boolean): string[] {
  const expectedRoles = [ETHOS_VERIFIED_ROLE_ID]; // Always has verified role
  
  // Add score-based role
  expectedRoles.push(getRoleIdForScore(score));
  
  // Add validator role if they own a validator
  if (hasValidator) {
    expectedRoles.push(ETHOS_VALIDATOR_ROLE_ID);
  }
  
  return expectedRoles;
}

// Function to sync a single user's roles
async function syncUserRoles(guildId: string, userId: string): Promise<{ success: boolean; changes: string[] }> {
  try {
    console.log(`Syncing roles for user: ${userId}`);
    
    // Get user's current Discord roles
    const memberUrl = `https://discord.com/api/v10/guilds/${guildId}/members/${userId}`;
    const memberResponse = await discordApiCall(memberUrl, { method: "GET" });
    
    if (!memberResponse.ok) {
      console.error(`Failed to fetch member ${userId}: ${memberResponse.status}`);
      return { success: false, changes: [] };
    }
    
    const memberData = await memberResponse.json();
    const currentRoles = memberData.roles || [];
    const currentEthosRoles = getCurrentEthosRoles(currentRoles);
    
    // Fetch user's Ethos profile
    const profile = await fetchEthosProfileByDiscord(userId);
    
    if ("error" in profile) {
      console.log(`User ${userId} has no valid Ethos profile, skipping sync`);
      return { success: true, changes: [] };
    }
    
    // Check validator status
    const hasValidator = await checkUserOwnsValidator(userId);
    
    // Get expected roles
    const expectedRoles = getExpectedRoles(profile.score, hasValidator);
    
    // Compare current vs expected roles
    const rolesToAdd = expectedRoles.filter(roleId => !currentRoles.includes(roleId));
    const rolesToRemove = currentEthosRoles.filter(roleId => !expectedRoles.includes(roleId));
    
    const changes: string[] = [];
    
    // Remove roles that shouldn't be there
    for (const roleId of rolesToRemove) {
      const removeUrl = `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`;
      const removeResponse = await discordApiCall(removeUrl, { method: "DELETE" });
      
      if (removeResponse.ok) {
        const roleName = getRoleNameFromId(roleId);
        changes.push(`Removed ${roleName} role`);
        console.log(`Removed role ${roleName} from user ${userId}`);
      }
      
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    
    // Add roles that should be there
    for (const roleId of rolesToAdd) {
      const addUrl = `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`;
      const addResponse = await discordApiCall(addUrl, { method: "PUT" });
      
      if (addResponse.ok) {
        const roleName = getRoleNameFromId(roleId);
        changes.push(`Added ${roleName} role`);
        console.log(`Added role ${roleName} to user ${userId}`);
      }
      
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    
    return { success: true, changes };
  } catch (error) {
    console.error(`Error syncing user ${userId}:`, error);
    return { success: false, changes: [] };
  }
}

// Helper function to get role name from role ID
function getRoleNameFromId(roleId: string): string {
  switch (roleId) {
    case ETHOS_VERIFIED_ROLE_ID: return "Verified";
    case ETHOS_VALIDATOR_ROLE_ID: return "Validator";
    case ETHOS_ROLE_EXEMPLARY: return "Exemplary";
    case ETHOS_ROLE_REPUTABLE: return "Reputable";
    case ETHOS_ROLE_NEUTRAL: return "Neutral";
    case ETHOS_ROLE_QUESTIONABLE: return "Questionable";
    case ETHOS_ROLE_UNTRUSTED: return "Untrusted";
    default: return "Unknown";
  }
}

// Main daily sync function
async function performDailySync(): Promise<void> {
  const GUILD_ID = Deno.env.get("DISCORD_GUILD_ID");
  
  if (!GUILD_ID) {
    console.error("DISCORD_GUILD_ID environment variable not set, skipping sync");
    return;
  }
  
  await performSyncForGuild(GUILD_ID);
}

// Manual sync function that can be triggered by command
async function performManualSync(guildId: string): Promise<void> {
  console.log(`=== Starting manual role synchronization for guild ${guildId} ===`);
  await performSyncForGuild(guildId);
}

// Core sync logic that can be used by both daily and manual sync
async function performSyncForGuild(guildId: string): Promise<void> {
  // Check if already running
  if (syncStatus.isRunning) {
    console.log("Sync already in progress, skipping");
    return;
  }

  // Initialize sync status
  syncStatus.isRunning = true;
  syncStatus.shouldStop = false;
  syncStatus.currentGuild = guildId;
  syncStatus.startTime = Date.now();
  syncStatus.processedUsers = 0;
  syncStatus.totalUsers = 0;

  console.log("=== Starting role synchronization ===");
  const startTime = Date.now();
  
  try {
    // Get all verified members
    const verifiedMembers = await getVerifiedMembers(guildId);
    
    if (verifiedMembers.length === 0) {
      console.log("No verified members found, sync complete");
      return;
    }
    
    syncStatus.totalUsers = verifiedMembers.length;
    console.log(`Starting sync for ${verifiedMembers.length} verified members`);
    
    let successCount = 0;
    let errorCount = 0;
    let totalChanges = 0;
    
    // Process users in batches to avoid overwhelming the API
    const BATCH_SIZE = 10;
    for (let i = 0; i < verifiedMembers.length; i += BATCH_SIZE) {
      // Check for stop signal
      if (syncStatus.shouldStop) {
        console.log("🛑 Sync stopped by user request");
        break;
      }

      const batch = verifiedMembers.slice(i, i + BATCH_SIZE);
      
      console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(verifiedMembers.length / BATCH_SIZE)}`);
      
      for (const userId of batch) {
        // Check for stop signal before each user
        if (syncStatus.shouldStop) {
          console.log("🛑 Sync stopped by user request");
          break;
        }

        const result = await syncUserRoles(guildId, userId);
        syncStatus.processedUsers++;
        
        if (result.success) {
          successCount++;
          totalChanges += result.changes.length;
          
          if (result.changes.length > 0) {
            console.log(`User ${userId}: ${result.changes.join(", ")}`);
          }
        } else {
          errorCount++;
        }
        
        // Delay between users to respect rate limits
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      // Break out of batch loop if stopped
      if (syncStatus.shouldStop) break;
      
      // Longer delay between batches
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    const status = syncStatus.shouldStop ? "stopped" : "complete";
    console.log(`=== Sync ${status} ===`);
    console.log(`Duration: ${duration}s`);
    console.log(`Processed: ${successCount} users`);
    console.log(`Errors: ${errorCount} users`);
    console.log(`Total changes: ${totalChanges}`);
    
  } catch (error) {
    console.error("Error during sync:", error);
  } finally {
    // Reset sync status
    resetSyncStatus();
  }
}

// Schedule daily sync (runs every 24 hours)
function scheduleDailySync(): void {
  console.log("Scheduling daily role synchronization...");
  
  // Run sync immediately on startup (optional)
  // performDailySync();
  
  // Schedule to run every 24 hours (86400000 milliseconds)
  setInterval(() => {
    performDailySync();
  }, 24 * 60 * 60 * 1000);
  
  console.log("Daily sync scheduled to run every 24 hours");
}

// Function to trigger a sync for any guild at any time
export async function triggerRoleSync(guildId?: string): Promise<void> {
  const targetGuildId = guildId || Deno.env.get("DISCORD_GUILD_ID");
  
  if (!targetGuildId) {
    console.error("No guild ID provided and DISCORD_GUILD_ID environment variable not set");
    return;
  }
  
  console.log(`Triggering role sync for guild: ${targetGuildId}`);
  await performSyncForGuild(targetGuildId);
}

// Start the daily sync scheduler (can be disabled by setting DISABLE_DAILY_SYNC=true)
if (!Deno.env.get("DISABLE_DAILY_SYNC")) {
  scheduleDailySync();
} else {
  console.log("Daily sync scheduler disabled via DISABLE_DAILY_SYNC environment variable");
} 