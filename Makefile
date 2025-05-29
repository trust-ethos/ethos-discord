# Ethos Discord Role Sync Makefile
# 
# Environment variables (set these in your .env or shell):
# - SYNC_BASE_URL: Base URL of your sync service (default: http://localhost:8000)
# - SYNC_AUTH_TOKEN: Optional authentication token
# - DISCORD_GUILD_ID: Your Discord guild ID

DENO_FLAGS := --allow-net --allow-env
SYNC_HELPER := deno run $(DENO_FLAGS) sync-helper.ts

.PHONY: help start complete status stop dev-start dev-status

help:
	@echo "🔧 Ethos Discord Role Sync Commands"
	@echo ""
	@echo "Development (local):"
	@echo "  make dev-start     - Start the main service locally"
	@echo "  make dev-status    - Check local sync status"
	@echo ""
	@echo "Sync Operations:"
	@echo "  make start         - Start a chunked sync"
	@echo "  make complete      - Run complete sync with auto-continuation"
	@echo "  make status        - Get current sync status"
	@echo "  make stop          - Stop current sync"
	@echo ""
	@echo "Custom chunk sizes:"
	@echo "  make start CHUNK_SIZE=30"
	@echo "  make complete CHUNK_SIZE=100"
	@echo ""
	@echo "Environment Variables:"
	@echo "  SYNC_BASE_URL      - Service URL (default: http://localhost:8000)"
	@echo "  SYNC_AUTH_TOKEN    - Optional auth token"
	@echo "  DISCORD_GUILD_ID   - Discord guild ID"

# Development commands
dev-start:
	@echo "🚀 Starting Ethos Discord service locally..."
	deno run $(DENO_FLAGS) mod.ts

dev-status:
	@echo "📊 Checking local sync status..."
	@SYNC_BASE_URL=http://localhost:8000 $(SYNC_HELPER) status

# Sync commands
start:
	@echo "🚀 Starting chunked role sync..."
	@$(SYNC_HELPER) start $(if $(CHUNK_SIZE),--chunk-size $(CHUNK_SIZE))

complete:
	@echo "🔄 Starting complete role sync with auto-continuation..."
	@$(SYNC_HELPER) complete $(if $(CHUNK_SIZE),--chunk-size $(CHUNK_SIZE))

status:
	@echo "📊 Getting sync status..."
	@$(SYNC_HELPER) status

stop:
	@echo "🛑 Stopping sync..."
	@$(SYNC_HELPER) stop

# Quick development workflow
dev: dev-start

# Production deployment helpers
deploy-status:
	@echo "📊 Checking production sync status..."
	@$(SYNC_HELPER) status

deploy-sync:
	@echo "🚀 Starting production sync..."
	@$(SYNC_HELPER) complete 