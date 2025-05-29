// Cron script for Deno Deploy
// This can be used with Deno Deploy's cron functionality

// Import the trigger function from the main module
import { triggerRoleSync } from "./mod.ts";

// Define the cron job handler
export async function handler() {
  console.log("Cron job triggered: Starting role synchronization");
  
  try {
    // You can specify a guild ID here or use the environment variable
    await triggerRoleSync();
    console.log("Cron job completed: Role synchronization finished");
  } catch (error) {
    console.error("Cron job failed:", error);
  }
} 