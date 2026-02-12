FROM denoland/deno:1.40.5

# Install Node.js and ethos-cli
RUN apt-get update && apt-get install -y curl \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g @trust-ethos/cli \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Verify ethos CLI is installed and accessible
RUN which ethos && ethos --version

# Ensure npm global bin dir is in PATH for Deno subprocess
ENV PATH="/usr/local/bin:/usr/bin:/usr/lib/node_modules/.bin:${PATH}"

# Set working directory
WORKDIR /app

# Copy all source code
COPY . .

# Cache dependencies and main application with all required flags
RUN deno cache --allow-net --allow-env --allow-read --allow-write --unstable deps.ts mod.ts

# Expose port
EXPOSE 8000

# Start the application with all required flags
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--allow-run", "--unstable", "mod.ts"] 