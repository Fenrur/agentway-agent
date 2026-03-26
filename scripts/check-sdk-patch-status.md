# Check SDK V2 Patch Status

Run this periodically to check if the SDK V2 patches are still needed or if Anthropic has fixed them upstream.

## Context

We patch `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` (see `scripts/patch-sdk.sh`) because the V2 session constructor (`unstable_v2_createSession`) hardcodes 3 values that break our use case:

1. **`includePartialMessages: false`** — no streaming text deltas (content_block_delta)
2. **`allowDangerouslySkipPermissions: false`** — can't use permissionMode: "bypassPermissions"
3. **`settingSources: []`** — passes `--setting-sources ""` which disables all MCP loading from .claude.json / .mcp.json / settings.json

## How to check

```bash
cd /Users/livio/Projects/agentway/agent

# 1. Check current SDK version
grep '"@anthropic-ai/claude-agent-sdk"' package.json

# 2. Check latest version available
bun info @anthropic-ai/claude-agent-sdk 2>/dev/null | head -5

# 3. Check if the V2 session constructor still hardcodes these values
grep -o 'includePartialMessages:.[01]' node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs
grep -o 'allowDangerouslySkipPermissions:.[01]' node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs
grep -o 'settingSources:\[\]' node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs

# 4. Check if SDKSessionOptions types now include these fields
grep -A2 'includePartialMessages\|settingSources\|allowDangerouslySkipPermissions' node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts | grep -B1 'SDKSession'

# 5. Check the V2 API changelog for relevant changes
# https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md
```

## When patches are no longer needed

- **includePartialMessages**: When `SDKSessionOptions` includes `includePartialMessages?: boolean` and V2 sessions support it natively
- **allowDangerouslySkipPermissions**: When `SDKSessionOptions` includes this field or `permissionMode: "bypassPermissions"` works without it
- **settingSources**: When V2 sessions pass `undefined` instead of `[]`, or when `SDKSessionOptions` includes `settingSources`

## Upgrade procedure

1. Update version in `package.json`
2. Run `bun install` (triggers `postinstall` → `patch-sdk.sh`)
3. If patch-sdk.sh says "WARNING: pattern not found" → the SDK changed, review manually
4. Test on a single agent VM before rolling out
5. If all 3 fields are now configurable in `SDKSessionOptions`, remove `patch-sdk.sh` and the `postinstall` script
