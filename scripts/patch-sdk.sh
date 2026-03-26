#!/bin/bash
# Patch the Claude Agent SDK V2 to enable features hardcoded to false:
#   1. includePartialMessages — needed for streaming text events (content_block_delta)
#   2. allowDangerouslySkipPermissions — needed for bypassPermissions mode
#
# The SDK V2 session constructor (yz class in sdk.mjs) hardcodes these to false.
# The V1 query API supports them, but V2 is still "unstable preview".
# This patch flips the flags in the minified source.
#
# Re-run after: bun install / bun add @anthropic-ai/claude-agent-sdk

SDK_FILE="node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"

if [ ! -f "$SDK_FILE" ]; then
  echo "[patch-sdk] SDK file not found: $SDK_FILE — skipping"
  exit 0
fi

# Check if already patched (all 3 patches applied)
if grep -q 'includePartialMessages:!0' "$SDK_FILE" 2>/dev/null && \
   grep -q 'settingSources:void 0' "$SDK_FILE" 2>/dev/null; then
  echo "[patch-sdk] Already patched — skipping"
  exit 0
fi

# Apply patches
sed -i.bak \
  -e 's/includePartialMessages:!1/includePartialMessages:!0/g' \
  -e 's/allowDangerouslySkipPermissions:!1/allowDangerouslySkipPermissions:!0/g' \
  -e 's/settingSources:\[\]/settingSources:void 0/g' \
  "$SDK_FILE"

rm -f "${SDK_FILE}.bak"

echo "[patch-sdk] Patched SDK V2: includePartialMessages=true, allowDangerouslySkipPermissions=true, settingSources=default"
