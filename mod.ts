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

if (!PUBLIC_KEY || !APPLICATION_ID) {
  console.error("Environment variables check failed:");
  console.error("DISCORD_PUBLIC_KEY:", PUBLIC_KEY ? "set" : "missing");
  console.error("DISCORD_APPLICATION_ID:", APPLICATION_ID ? "set" : "missing");
  // Don't throw, just log the error
}

// Function to fetch Ethos profile
async function fetchEthosProfile(handle: string) {
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
        return { error: `No Ethos profile found for @${formattedHandle}. They can create one at https://ethos.network` };
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
    console.error("Error fetching Ethos profile:", error);
    return { error: "Something went wrong while fetching the profile. Please try again later." };
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
      if (interaction.data?.name !== "ethos") {
        return {
          type: InteractionResponseType.ChannelMessageWithSource,
          data: {
            content: "Unknown command",
            flags: 64 // Ephemeral
          }
        };
      }

      const twitterHandle = interaction.data.options?.[0].value?.toString().replace("@", "");
      if (!twitterHandle) {
        return {
          type: InteractionResponseType.ChannelMessageWithSource,
          data: {
            content: "Please provide a Twitter handle!",
            flags: 64 // Ephemeral
          }
        };
      }

      const profile = await fetchEthosProfile(twitterHandle);
      
      if ("error" in profile) {
        return {
          type: InteractionResponseType.ChannelMessageWithSource,
          data: {
            content: profile.error,
            flags: 64 // Ephemeral
          }
        };
      }

      return {
        type: InteractionResponseType.ChannelMessageWithSource,
        data: {
          embeds: [{
            title: `Ethos profile for @${twitterHandle}`,
            url: `https://app.ethos.network/profile/x/${twitterHandle}?src=discord-agent`,
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
  if (req.method === "POST") {
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

  return new Response("OK", { status: 200 });
}); 