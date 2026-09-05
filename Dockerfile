# ============================================================================
# Seepient Dockerfile — Production Multi-Stage Build
# ============================================================================
# Builds a minimal production image with Chromium + CJK fonts for Playwright
# browser tools, compiles the native fs-commit helper, and supports both
# standalone server mode and CLI mode.
#
# Usage:
#   Server mode (default):  docker run -p 7337:7337 seepient
#   CLI mode:               docker run seepient seepient chat "hello" --docker
#   With env file:          docker run -p 7337:7337 --env-file .env seepient
# ============================================================================

# ---------------------------------------------------------------------------
# Stage 1: Build
# ---------------------------------------------------------------------------
FROM node:22.19-slim AS builder

# Install build dependencies: pnpm + Rust/Cargo for native commit helper
RUN apt-get update && apt-get install -y --no-install-recommends \
    cargo \
    gcc \
    libc6-dev \
    && rm -rf /var/lib/apt/lists/*

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

# Copy native helper source and build for Linux
COPY native/ ./native/
COPY scripts/ ./scripts/
RUN cargo build --manifest-path native/fs-commit/Cargo.toml --release \
    && node scripts/place-native-helper.cjs

# Prune devDependencies — keep only what's needed at runtime
RUN pnpm prune --prod

# ---------------------------------------------------------------------------
# Stage 2: Production Runtime
# ---------------------------------------------------------------------------
FROM node:22.19-slim AS production

# Container metadata
LABEL org.opencontainers.image.title="Seepient Agent"
LABEL org.opencontainers.image.description="Lightweight AI agent CLI and server with multi-provider LLM support"
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

# Point native exact-commit helper to the Linux binary
ENV SEEPIENT_FS_COMMIT_BIN=/usr/local/bin/seepient-fs-commit

# Create non-root user for security
RUN groupadd --gid 1001 appuser \
    && useradd --uid 1001 --gid appuser --shell /bin/bash --create-home appuser

# Application directory
WORKDIR /app

# Copy production artifacts from builder stage
COPY --from=builder /build/dist/           ./dist/
COPY --from=builder /build/node_modules/   ./node_modules/
COPY --from=builder /build/package.json    ./

# Copy compiled native helper binary to /usr/local/bin
COPY --from=builder /build/native/fs-commit/target/release/seepient-fs-commit /usr/local/bin/seepient-fs-commit

# Copy bundled skills
COPY skills/ ./skills/

# Copy license and documentation
COPY LICENSE  ./
COPY README.md ./

# Link CLI and server binaries to system PATH
RUN ln -s /app/dist/ui/cli/index.js /usr/local/bin/seepient \
    && ln -s /app/dist/transport/http/standalone.js /usr/local/bin/seepient-server \
    && chmod +x /app/dist/ui/cli/index.js /app/dist/transport/http/standalone.js /usr/local/bin/seepient-fs-commit

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

# Health check — verifies the server is responding on /v1/health
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD node -e "const http = require('http'); \
    const req = http.get('http://localhost:7337/v1/health', (res) => { \
        process.exit(res.statusCode === 200 ? 0 : 1); \
    }); \
    req.on('error', () => process.exit(1)); \
    req.setTimeout(5000, () => { req.destroy(); process.exit(1); });"

# Entrypoint: dumb-init as PID 1 supervisor
ENTRYPOINT ["dumb-init", "--"]

# Default command: start the standalone HTTP/WebSocket server
CMD ["node", "/app/dist/transport/http/standalone.js"]
