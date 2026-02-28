#!/usr/bin/env bash
# CDK Docker bundling script — builds the FFmpeg Lambda layer.
#
# This script runs inside an Amazon Linux container during `cdk deploy`.
# It installs the ffmpeg-static npm package (which downloads a pre-built
# static FFmpeg binary for the current platform — Linux x86_64 in this context)
# and copies just the binary to /asset-output/bin, which CDK packages as a layer.
#
# The resulting layer mounts the binary at /opt/bin/ffmpeg inside Lambda.
set -euo pipefail

# Install in /tmp so we have write access (CDK mounts /asset-input as read-only).
# Set HOME=/tmp so npm uses /tmp/.npm as its cache — when CDK runs Docker with the
# host user's UID, the default /.npm cache directory is not writable.
cd /tmp
HOME=/tmp npm install --prefix /tmp ffmpeg-static 2>/dev/null

# Resolve the binary path — ffmpeg-static exports the path as its module value
FFMPEG_BIN=$(node -e "process.stdout.write(require('/tmp/node_modules/ffmpeg-static'))")

mkdir -p /asset-output/bin
cp "${FFMPEG_BIN}" /asset-output/bin/ffmpeg
chmod 755 /asset-output/bin/ffmpeg

echo "FFmpeg binary copied: $(du -sh /asset-output/bin/ffmpeg)"
