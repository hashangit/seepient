# ============================================================================
# Seepient Dockerfile — Production Multi-Stage Build
# ============================================================================
# Builds a minimal production image with Chromium + CJK fonts for Playwright
# browser tools. Supports both CLI mode and server mode.
#
# Usage:
#   Server mode (default):  docker run seepient
#   CLI mode:               docker run seepient seepient chat "hello"
#   With env file:          docker run --env-file .env seepient
# ============================================================================

# ---------------------------------------------------------------------------
# Stage 1: Build
# ---------------------------------------------------------------------------
FROM node:22.19-slim AS builder

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /build

# Copy dependency manifests first for layer caching
COPY package.json pnpm-lock.yaml ./

# Install ALL dependencies (including devDependencies for tsc)
RUN pnpm install --frozen-lockfile

# Copy TypeScript source and config
COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript to JavaScript
RUN pnpm run build

# Prune devDependencies — keep only what's needed at runtime
RUN pnpm prune --prod

# ---------------------------------------------------------------------------
# Stage 2: Production Runtime
# ---------------------------------------------------------------------------
FROM node:22.19-slim AS production

# Container metadata
LABEL org.opencontainers.image.title="Seepient Agent"
LABEL org.opencontainers.image.description="Lightweight AI agent CLI with multi-provider LLM support"
LABEL org.opencontainers.image.source="https://github.com/hashangit/seepient"
LABEL org.opencontainers.image.licenses="BUSL-1.1"

# Install Chromium + required fonts + runtime dependencies
# - chromium: system Chromium for Playwright (avoids bundled download)
# - fonts-noto-cjk: CJK (Chinese/Japanese/Korean) font support
# - fonts-noto-color-emoji: emoji rendering in screenshots
# - ca-certificates: HTTPS certificate validation
# - dumb-init: lightweight PID 1 init for proper signal handling
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    ca-certificates \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Set Playwright to use system Chromium instead of bundled browsers
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Production environment
ENV NODE_ENV=production

# Shell tool auto-approve for non-interactive containers
# Set to "auto" to allow command execution without prompts
# Set to "deny" (or leave unset) to block commands in non-interactive mode
ENV SEEPIENT_SHELL_APPROVE=auto

# Create non-root user for security
RUN groupadd --gid 1001 appuser \
    && useradd --uid 1001 --gid appuser --shell /bin/bash --create-home appuser

# Application directory
WORKDIR /app

# Copy production artifacts from builder stage
COPY --from=builder /build/dist/           ./dist/
COPY --from=builder /build/node_modules/   ./node_modules/
COPY --from=builder /build/package.json    ./

# Copy bundled skills
COPY skills/ ./skills/

# Copy license and documentation
COPY LICENSE  ./
COPY README.md ./

# Create volume mount points for persistent data
# - /data/sessions: conversation session history
# - /mnt/skills:    custom skills mounted at runtime
# - /workspace:     working directory for agent tasks
RUN mkdir -p /data/sessions /mnt/skills /workspace \
    && chown -R appuser:appuser /app /data /mnt/skills /workspace

VOLUME ["/data/sessions", "/mnt/skills", "/workspace"]

# Switch to non-root user
USER appuser

# Default working directory for agent file operations
WORKDIR /workspace

# Server port
EXPOSE 7337

# Health check — verifies the server is responding
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD node -e "const http = require('http'); \
    const req = http.get('http://localhost:7337/v1/health', (res) => { \
        process.exit(res.statusCode === 200 ? 0 : 1); \
    }); \
    req.on('error', () => process.exit(1)); \
    req.setTimeout(5000, () => { req.destroy(); process.exit(1); });"

# Entrypoint: node with the CLI adapter
# This allows both server mode (default CMD) and CLI commands
ENTRYPOINT ["dumb-init", "--", "node", "dist/adapters/cli/index.js"]

# Default command: start the server adapter
# Override with any seepient CLI subcommand, e.g.:
#   docker run seepient chat "explain this code"
#   docker run seepient --help
CMD ["--serve"]
