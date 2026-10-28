#!/usr/bin/env bash
# ==============================================================================
# Fast Incremental Docker Build Script for Dockge + PBS (`./build-docker.sh`)
#
# Upstream Dockge splits its Docker build across 3 files:
#   1. `docker/BuildHealthCheck.Dockerfile` -> `louislam/dockge:build-healthcheck`
#   2. `docker/Base.Dockerfile`             -> `louislam/dockge:base`
#   3. `docker/Dockerfile`                  -> Final Dockge image
#
# How this script keeps rebuilds fast (1-2 seconds on code edits):
#   - Only builds `louislam/dockge:build-healthcheck` once if missing locally.
#   - Only builds `louislam/dockge:base` once if missing locally (or lacking PBS client).
#   - Only runs `npm run build:frontend` if files in `frontend/` or `common/`
#     are newer than `frontend-dist/index.html`.
#   - Reuses Docker BuildKit layer cache for `npm ci --omit=dev` unless
#     `package.json` / `package-lock.json` changed.
#
# Usage:
#   ./build-docker.sh                     # Fast incremental build (tags `dockge-pbs:latest`)
#   ./build-docker.sh my-tag:dev          # Fast build with custom image tag
#   ./build-docker.sh --rebuild-frontend  # Force frontend rebuild + image build
#   ./build-docker.sh --rebuild-base      # Force Base.Dockerfile rebuild + image build
#   ./build-docker.sh --full              # Force full rebuild of all stages
# ==============================================================================

set -euo pipefail

cd "$(dirname "$0")"

IMAGE_TAG="dockge-pbs:latest"
HEALTHCHECK_IMAGE="louislam/dockge:build-healthcheck"
BASE_IMAGE="louislam/dockge:base"
PLATFORM="linux/amd64"
FORCE_BASE=false
FORCE_FRONTEND=false

for arg in "$@"; do
    case "$arg" in
        --rebuild-base)
            FORCE_BASE=true
            ;;
        --rebuild-frontend)
            FORCE_FRONTEND=true
            ;;
        --full)
            FORCE_BASE=true
            FORCE_FRONTEND=true
            ;;
        *)
            IMAGE_TAG="$arg"
            ;;
    esac
done

export DOCKER_BUILDKIT=1

# ------------------------------------------------------------------------------
# Step 1: Build `louislam/dockge:build-healthcheck` once if missing locally
# ------------------------------------------------------------------------------
if [ "$FORCE_BASE" = true ] || ! docker image inspect "$HEALTHCHECK_IMAGE" >/dev/null 2>&1; then
    echo "==> [1/4] Building healthcheck image ($HEALTHCHECK_IMAGE for $PLATFORM)..."
    docker build --platform "$PLATFORM" -f docker/BuildHealthCheck.Dockerfile -t "$HEALTHCHECK_IMAGE" .
else
    echo "==> [1/4] Healthcheck image ($HEALTHCHECK_IMAGE) already built (cached)."
fi

# ------------------------------------------------------------------------------
# Step 2: Build `louislam/dockge:base` only if missing or lacking PBS client
# ------------------------------------------------------------------------------
NEEDS_BASE=false
if [ "$FORCE_BASE" = true ]; then
    NEEDS_BASE=true
elif ! docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
    NEEDS_BASE=true
elif ! docker run --rm --platform "$PLATFORM" --entrypoint sh "$BASE_IMAGE" -c "command -v proxmox-backup-client" >/dev/null 2>&1; then
    NEEDS_BASE=true
fi

if [ "$NEEDS_BASE" = true ]; then
    echo "==> [2/4] Building base image ($BASE_IMAGE for $PLATFORM with proxmox-backup-client)..."
    docker build --platform "$PLATFORM" -f docker/Base.Dockerfile -t "$BASE_IMAGE" .
else
    echo "==> [2/4] Base image ($BASE_IMAGE) already up-to-date (cached)."
fi

# ------------------------------------------------------------------------------
# Step 3: Rebuild `frontend-dist` only if frontend/common sources changed
# ------------------------------------------------------------------------------
NEEDS_FRONTEND=false
if [ "$FORCE_FRONTEND" = true ] || [ ! -f "frontend-dist/index.html" ]; then
    NEEDS_FRONTEND=true
elif [ -n "$(find frontend common -type f -newer frontend-dist/index.html 2>/dev/null | head -n 1)" ]; then
    NEEDS_FRONTEND=true
fi

if [ "$NEEDS_FRONTEND" = true ]; then
    echo "==> [3/4] Frontend changes detected — building frontend-dist..."
    npm run build:frontend
else
    echo "==> [3/4] Frontend unchanged since last build (skipping vite build)."
fi

# ------------------------------------------------------------------------------
# Step 4: Build final Dockge image (reuses cached npm ci & base layers)
# ------------------------------------------------------------------------------
echo "==> [4/4] Building $IMAGE_TAG ($PLATFORM)..."
docker build --platform "$PLATFORM" -f docker/Dockerfile -t "$IMAGE_TAG" .

echo "==> Done! Image built: $IMAGE_TAG"
