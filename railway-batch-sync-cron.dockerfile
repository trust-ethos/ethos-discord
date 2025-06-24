FROM denoland/deno:1.40.5

# Set working directory
WORKDIR /app

# Copy the cron service script
COPY railway-cron.ts .

# Cache dependencies
RUN deno cache --allow-net --allow-env railway-cron.ts

# Run the batch sync job
CMD ["deno", "run", "--allow-net", "--allow-env", "railway-cron.ts", "batch-sync"] 