#!/usr/bin/env -S deno run --allow-net --allow-env

/**
 * Test Batch API Response Structure
 * 
 * This script tests the actual response structure from the Ethos batch APIs
 * to debug why user data is missing.
 */

export {};

const testUserId = "252879043899162624"; // The user having issues
const userkey = `service:discord:${testUserId}`;

console.log("🧪 Testing Ethos Batch APIs");
console.log("==========================");

// Test Score API
console.log("\n📊 Testing Score API:");
try {
  const scoresResponse = await fetch(`https://api.ethos.network/api/v2/score/userkeys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userkeys: [userkey] })
  });

  console.log(`Status: ${scoresResponse.status} ${scoresResponse.statusText}`);
  
  if (scoresResponse.ok) {
    const scoresData = await scoresResponse.json();
    console.log("Response structure:", Object.keys(scoresData));
    console.log("Full response:", JSON.stringify(scoresData, null, 2));
  } else {
    console.log("Error response:", await scoresResponse.text());
  }
} catch (error) {
  console.error("Score API error:", error);
}

// Test Stats API  
console.log("\n📈 Testing Stats API:");
try {
  const statsResponse = await fetch(`https://api.ethos.network/api/v2/users/by/x`, {
    method: "POST", 
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountIdsOrUsernames: [userkey] })
  });

  console.log(`Status: ${statsResponse.status} ${statsResponse.statusText}`);
  
  if (statsResponse.ok) {
    const statsData = await statsResponse.json();
    console.log("Response structure:", Array.isArray(statsData) ? 'array' : 'object');
    console.log("Full response:", JSON.stringify(statsData, null, 2));
  } else {
    console.log("Error response:", await statsResponse.text());
  }
} catch (error) {
  console.error("Stats API error:", error);
}

// Compare with individual API calls
console.log("\n🔍 Comparing with Individual APIs:");

// Individual Score API
try {
  const individualScoreResponse = await fetch(`https://api.ethos.network/api/v1/score/${userkey}`);
  if (individualScoreResponse.ok) {
    const individualScoreData = await individualScoreResponse.json();
    console.log("Individual Score API:", JSON.stringify(individualScoreData, null, 2));
  }
} catch (error) {
  console.error("Individual score API error:", error);
}

// Individual Stats API
try {
  const individualStatsResponse = await fetch(`https://api.ethos.network/api/v1/users/${userkey}/stats`);
  if (individualStatsResponse.ok) {
    const individualStatsData = await individualStatsResponse.json();
    console.log("Individual Stats API:", JSON.stringify(individualStatsData, null, 2));
  }
} catch (error) {
  console.error("Individual stats API error:", error);
} 