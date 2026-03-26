# Claude Agent SDK V2 — Patches requis (version 0.2.84)

## Contexte

AgentWay utilise le Claude Agent SDK V2 (`@anthropic-ai/claude-agent-sdk`) pour faire tourner des agents Claude Code dans des VMs LXC isolées. L'API V2 (`unstable_v2_createSession` / `unstable_v2_resumeSession`) permet des sessions persistantes multi-turn, éliminant le besoin de spawner un nouveau process par message.

Cependant, le constructeur V2 de session (classe interne `yz` dans `sdk.mjs`) hardcode trois valeurs qui cassent notre cas d'usage. On applique un patch `sed` sur `sdk.mjs` via un script `postinstall` (`scripts/patch-sdk.sh`).

## Les 3 patches

### 1. `includePartialMessages: false` → `true`

**Problème** : Le SDK V2 ne produit pas de `stream_event` (events de type `content_block_delta`, `message_start`, etc.). Sans eux, l'UI ne reçoit pas le texte en streaming — elle attend la réponse complète.

**Cause** : Le constructeur V2 passe `includePartialMessages:!1` au ProcessTransport interne. Le ProcessTransport convertit ça en l'absence du flag `--include-partial-messages` dans les args CLI.

**Impact sans patch** : 0 events `stream_event` au lieu de ~7 par réponse. L'UI n'affiche rien jusqu'à la fin de la réponse complète.

**Patch** : `sed 's/includePartialMessages:!1/includePartialMessages:!0/g'`

**Référence** : L'option `includePartialMessages` existe dans l'API V1 (`SDKQueryOptions`) mais n'a pas été portée vers `SDKSessionOptions` (V2). La doc officielle de streaming (https://platform.claude.com/docs/en/agent-sdk/streaming-output) ne montre que des exemples V1.

### 2. `allowDangerouslySkipPermissions: false` → `true`

**Problème** : L'option `permissionMode: "bypassPermissions"` dans `SDKSessionOptions` ne suffit pas. Le CLI requiert aussi le flag `--allow-dangerously-skip-permissions` pour activer ce mode.

**Cause** : Le constructeur V2 passe `allowDangerouslySkipPermissions:!1` au ProcessTransport. Le flag `--allow-dangerously-skip-permissions` n'est jamais ajouté aux args CLI même quand `permissionMode: "bypassPermissions"` est utilisé.

**Impact sans patch** : Les agents ne peuvent pas exécuter d'actions autonomes. Chaque outil demande une confirmation de permission (impossible en mode headless).

**Patch** : `sed 's/allowDangerouslySkipPermissions:!1/allowDangerouslySkipPermissions:!0/g'`

**Référence** : `allowDangerouslySkipPermissions` existe dans `SDKQueryOptions` (V1) et est documenté comme requis pour `permissionMode: "bypassPermissions"`. Absent de `SDKSessionOptions` (V2).

### 3. `settingSources: []` → `undefined`

**Problème** : Le SDK V2 passe `--setting-sources ""` (chaîne vide) au CLI, ce qui désactive le chargement de TOUTES les sources de configuration. Résultat : aucun MCP server n'est chargé depuis `.claude.json`, `.mcp.json`, ou `settings.json`.

**Cause** : Le constructeur V2 passe `settingSources:[]`. Le ProcessTransport fait `if(h && h.length > 0) p.push("--setting-sources", h.join(","))`. Mais `[]` est truthy en JS et le test devrait être `h.length > 0` — or dans le code minifié, le test semble passer et `[].join(",")` produit `""`.

*Note : en relisant le code minifié, il semble que le check `h.length > 0` est bien présent. Le bug pourrait venir d'une subtilité dans la minification ou d'un chemin de code différent. Le résultat observable est que `--setting-sources ""` est passé au CLI.*

**Impact sans patch** : Aucun MCP (chrome-devtools, claude-mem, etc.) n'est disponible. Seuls les MCPs cloud (claude.ai Context7, etc.) fonctionnent car ils sont injectés par un autre mécanisme.

**Patch** : `sed 's/settingSources:\[\]/settingSources:void 0/g'`

Avec `void 0` (undefined), le check `if(h && h.length > 0)` est false, le flag `--setting-sources` n'est pas passé du tout, et le CLI utilise ses sources par défaut.

**Vérification** : On peut confirmer le problème en inspectant les args du process :
```bash
ps aux | grep cli.js
# Avant patch : --setting-sources  (vide)
# Après patch : pas de --setting-sources du tout
```

## Comment vérifier si les patches sont encore nécessaires

Quand une nouvelle version du SDK sort, vérifier dans le source `sdk.mjs` :

```bash
# Checker les valeurs hardcodées dans le constructeur V2
grep -o 'includePartialMessages:.[01]' node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs
grep -o 'allowDangerouslySkipPermissions:.[01]' node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs
grep -o 'settingSources:\[\]' node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs
```

Si les valeurs sont toujours `!1`, `!1`, `[]` → les patches sont encore nécessaires.

Vérifier aussi si `SDKSessionOptions` a été étendu avec ces champs :

```bash
grep -A2 'includePartialMessages\|settingSources\|allowDangerouslySkipPermissions' node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts | grep -B1 'SDKSession'
```

Si ces champs apparaissent dans `SDKSessionOptions`, on peut les passer directement via les options au lieu de patcher.

## Liens utiles

- SDK V2 preview doc : https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview
- Streaming doc (V1 only) : https://platform.claude.com/docs/en/agent-sdk/streaming-output
- MCP doc : https://platform.claude.com/docs/en/agent-sdk/mcp
- SDK TypeScript repo : https://github.com/anthropics/claude-agent-sdk-typescript
- Changelog : https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md
