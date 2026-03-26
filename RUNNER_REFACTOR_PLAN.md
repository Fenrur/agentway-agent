# Plan de refonte : Runner avec Agent SDK V2 (sessions persistantes)

## Probleme actuel

Le daemon spawn un nouveau process `claude -p "prompt" --continue` par message. Chaque invocation :
- Relance Claude Code from scratch (10-30s de chargement MCPs)
- Kill = SIGKILL = session perdue = perte de contexte
- Pas d'interruption gracieuse possible (Esc en interactif n'existe pas en `-p`)

## Solution : Agent SDK V2 (sessions persistantes)

Remplacer `Bun.spawn(["claude", "-p", ...])` par le **Claude Agent SDK TypeScript V2** qui maintient une session persistante avec `send()`/`stream()`.

### SDK V2 API

```typescript
import { unstable_v2_createSession, unstable_v2_resumeSession } from "@anthropic-ai/claude-agent-sdk";

// Creer une session (une seule fois au demarrage du daemon)
const session = unstable_v2_createSession({ model: "claude-opus-4-6" });

// Envoyer un message (multi-turn, pas de respawn)
await session.send("Fais ceci...");

// Streamer la reponse
for await (const msg of session.stream()) {
  if (msg.type === "assistant") { /* forward to UI */ }
}

// Envoyer un autre message (meme session, tout le contexte est la)
await session.send("Continue...");
for await (const msg of session.stream()) { ... }

// Resume apres restart du daemon
const resumed = unstable_v2_resumeSession(sessionId, { model: "claude-opus-4-6" });
```

### Avantages

1. **Session persistante** — un seul process Claude, pas de rechargement MCPs a chaque message
2. **Interruption propre** — au lieu de SIGKILL, on break le `for await` du stream et on send() le prochain message
3. **Contexte complet** — Claude a tout l'historique, meme apres "stop"
4. **Reprise apres restart** — `resumeSession(sessionId)` reprend exactement ou on en etait
5. **Plus rapide** — pas de spawn/init/MCPs a chaque message (~10-30s gagnes)

## Plan d'implementation

### Phase 1 : Installer le SDK

```bash
cd /opt/agentway-agent
bun add @anthropic-ai/claude-agent-sdk
```

Ajouter dans le template Packer : `bun install` dans Phase 13.

### Phase 2 : Refactorer le runner

**Fichier** : `agent/src/claude/runner.ts`

Remplacer :
- `spawnClaude(prompt)` → `session.send(prompt)` + `session.stream()`
- `killActive()` → break le stream iterator (pas de kill process)
- `--continue` logic → `resumeSession(sessionId)` au demarrage si session existante
- NDJSON parsing → les events SDK sont deja parses (SDKMessage)

```typescript
// State
let session: SDKSession | null = null;
let streamIterator: AsyncGenerator | null = null;
let isStreaming = false;

// Initialiser la session au premier message ou au resume
async function ensureSession(): Promise<SDKSession> {
  if (session) return session;

  const existingSessionId = await loadSessionId();
  if (existingSessionId) {
    session = unstable_v2_resumeSession(existingSessionId, {
      model: "claude-opus-4-6",
      // MCPs charges automatiquement par le SDK
    });
  } else {
    session = unstable_v2_createSession({
      model: "claude-opus-4-6",
    });
  }
  return session;
}

// Envoyer un message
async function runPrompt(prompt: string): Promise<void> {
  const s = await ensureSession();

  sendMessage({ type: "status", status: "working" });

  await s.send(prompt);
  isStreaming = true;

  for await (const msg of s.stream()) {
    if (!isStreaming) break; // User clicked stop → graceful interrupt

    // Forward events au backend (meme format que avant)
    sendMessage({ type: "stream_event", event: msg });

    if (msg.type === "result") {
      saveSessionId(msg.session_id);
    }
  }

  isStreaming = false;
  sendMessage({ type: "status", status: "idle" });
}

// Interruption gracieuse (bouton stop)
function interruptCurrent(): void {
  isStreaming = false; // Le for-await va break
  // PAS de SIGKILL — la session reste intacte
  // Le prochain send() reprend dans la meme session
}
```

### Phase 3 : Adapter le format des events

Les events SDK V2 (`SDKMessage`) ont un format different des events NDJSON CLI :

**CLI NDJSON** :
```json
{"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hello"}}
{"type": "assistant", "message": {"content": [...]}}
{"type": "result", "result": "...", "session_id": "..."}
```

**SDK V2** :
```json
{"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "..."}]}, "session_id": "..."}
{"type": "result", "subtype": "success", "result": "...", "session_id": "..."}
```

**Action** : adapter le mapping dans le daemon pour que le backend/frontend recoive le meme format qu'avant, OU adapter le backend/frontend pour comprendre le format SDK V2.

Option recommandee : adapter le daemon pour convertir SDK V2 → format actuel (minimise les changements backend/frontend).

### Phase 4 : Gerer le lifecycle

```
Daemon start
  → loadSessionId() → si existe → resumeSession()
  → sinon → createSession() au premier message

Message user
  → session.send(prompt)
  → for await (stream()) → forward events
  → auto-continue si necessaire

Bouton Stop
  → isStreaming = false → break stream
  → session reste ouverte → prochain message dans meme contexte

/reload
  → session.close()
  → session = null
  → prochain message → createSession() (nouvelle session, MCPs recharges)

Daemon restart (SIGTERM)
  → saveSessionId() → session.close()
  → au restart → resumeSession()

Kill user (SIGKILL impossible — le SDK gere)
  → isStreaming = false
  → session reste intacte
```

### Phase 5 : Adapter le backend

**Changements minimes** :
- Le daemon envoie les memes types de messages WS (stream_event, status)
- Le format des events peut differer legerement → adapter le mapping
- L'auto-continue peut etre simplifie (le SDK gere mieux les turns)

### Phase 6 : Adapter le template Packer

- Ajouter `@anthropic-ai/claude-agent-sdk` dans les deps du daemon
- Le SDK utilise le meme auth (OAuth token dans `.credentials.json` ou API key dans `.env`)

## Contraintes

- **SDK V2 est "unstable preview"** — APIs peuvent changer. Mais c'est la direction officielle d'Anthropic.
- **Pas de session forking en V2** — si besoin, rester sur V1 pour certains cas
- **Le SDK spawn Claude Code en background** — le process tourne dans le daemon, pas un spawn separee
- **MCPs** — le SDK charge les MCPs automatiquement depuis la config (`settings.json`, `.claude.json`)

## Migration progressive

1. Installer le SDK et creer un runner V2 parallele (`runner-v2.ts`)
2. Ajouter un flag pour basculer entre l'ancien runner (CLI) et le nouveau (SDK)
3. Tester en production avec un agent
4. Migrer tous les agents
5. Supprimer l'ancien runner

## Sources

- [TypeScript SDK V2 Preview](https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview)
- [Sessions API](https://platform.claude.com/docs/en/agent-sdk/sessions)
- [Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- [SDK Demos](https://github.com/anthropics/claude-agent-sdk-demos)
- [V2 API Issue #120 (interrupt)](https://github.com/anthropics/claude-agent-sdk-typescript/issues/120)
- [input-format stream-json (undocumented)](https://github.com/anthropics/claude-code/issues/24594)
