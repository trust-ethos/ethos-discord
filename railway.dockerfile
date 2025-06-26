FROM denoland/deno:1.40.5

# Set working directory
WORKDIR /app

# Copy all source code
COPY . .

# Cache dependencies and main application with all required flags
RUN deno cache --allow-net --allow-env --allow-read --allow-write --unstable deps.ts mod.ts

# Expose port
EXPOSE 8000

# Start the application with all required flags
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--unstable", "mod.ts"] 