// Simple health check for Docker containers
export {};

const port = Deno.env.get("PORT") || "8000";

try {
  const response = await fetch(`http://localhost:${port}/health`);
  
  if (response.ok) {
    const data = await response.json();
    if (data.status === "healthy") {
      console.log("✅ Health check passed");
      Deno.exit(0);
    }
  }
  
  console.log("❌ Health check failed");
  Deno.exit(1);
} catch (error) {
  console.log("❌ Health check error:", error.message);
  Deno.exit(1);
} 