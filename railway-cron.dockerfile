FROM denoland/deno:1.40.5

# Set working directory
WORKDIR /app

# Copy dependency files
COPY deno.json deno.lock ./

# Copy source code
COPY . .

# Cache the cron manager
RUN deno cache --allow-net --allow-env railway-cron.ts

# Expose port for status server
EXPOSE 8001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8001/health || exit 1

# Start the cron manager
CMD ["deno", "run", "--allow-net", "--allow-env", "railway-cron.ts"] 