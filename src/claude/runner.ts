// src/claude/runner.ts
// Coeur du daemon : session SDK V2 persistante, forward events au backend.
// Remplace l'ancien pattern Bun.spawn + NDJSON par une session multi-turn.
//
// Architecture :
//   - Une seule session SDK V2 par daemon (creee au premier message, resumee au restart)
//   - send() + stream() au lieu de spawn() un process par message
//   - interruptCurrent() break le for-await au lieu de SIGKILL
//   - Les events SDK ont le meme format que le CLI NDJSON (assistant, user, result, system, stream_event)

import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  type SDKMessage,
  type SDKSession,
} from "@anthropic-ai/claude-agent-sdk";
import { sendMessage } from "../ws/client.ts";
import { loadSession, saveSession, clearSession } from "./session.ts";

// === Constantes ===

/** Maximum execution time for a single turn (30 minutes) */
const MAX_TURN_MS = 30 * 60 * 1000;

/** Pattern pour detecter un lien d'auth dans le texte */
const AUTH_URL_PATTERN = /https?:\/\/[^\s"'<>]*(?:claude\.ai|anthropic\.com)[^\s"'<>]*/i;

/** Max auto-continue iterations to prevent infinite loops */
const MAX_AUTO_CONTINUES = 10;

// Memory flush removed — with persistent SDK V2 sessions, Claude keeps
// full context across messages. The old flush (saving to claude-mem) was
// needed when each message spawned a new process. Now it would pollute
// the conversation history since session.send() injects it as a real
// user message visible to Claude.

// === File paths ===

const BOOT_FILE = "/home/agent/.agent/BOOTSTRAP.md";
const CLAUDE_MD_FILE = "/home/agent/CLAUDE.md";
const RUNNING_PROMPT_FILE = "/home/agent/.agentway-running-prompt.json";

// === State ===

/** SDK V2 persistent session */
let session: SDKSession | null = null;

/** True for the entire runPrompt lifecycle (includes auto-continue + memory flush) */
let isRunning = false;

/** True while actively iterating a stream() response */
let isStreaming = false;

/** Flag to gracefully abort the current stream */
let streamAborted = false;


/** True if a "result" event was received during the current turn */
let resultReceived = false;

/** Whether the current interrupt was user-initiated */
let userInitiatedInterrupt = false;

/** Last result text — used to detect incomplete tasks */
let lastResultText = "";

/** Count of non-result events in the current turn */
let eventCount = 0;

/** Whether the last result was an error */
let lastResultIsError = false;

/** Current auto-continue count */
let autoContinueCount = 0;

/** Tracks whether BOOTSTRAP.md has been injected in this session */
let bootInjected = false;

// === System prompt ===

const AGENT_SYSTEM_PROMPT = [
  "## Regles d'execution",
  "",
  "Tu es un agent autonome qui tourne dans une VM isolee.",
  "",
  "### Execution des taches",
  "- Quand on te donne une tache avec un nombre precis (ex: 'ajoute 100 personnes'), execute-la en TOTALITE sans t'arreter pour demander confirmation.",
  "- Ne fais jamais de 'checkpoint' intermediaire pour demander si tu dois continuer. Continue jusqu'a la fin.",
  "- Si tu rencontres une erreur sur un element, log-la et passe au suivant. Ne t'arrete pas pour une seule erreur.",
  "- Si tu atteins une limite technique (tokens, timeout), fais un resume de ta progression et indique combien il en reste.",
  "",
  "### Communication",
  "- Sois bref et direct. Pas de formules creuses ni de 'Excellente question !'.",
  "- Reponds en francais sauf si l'utilisateur parle en anglais.",
  "- Quand tu executes des actions repetitives, ne decris pas chaque etape. Fais-les et donne un resume a la fin.",
  "",
  "### Persona et identite",
  "- Tes fichiers de persona sont dans `~/.agent/`. Lis-les au debut de chaque session pour connaitre ton identite.",
  "  - `SOUL.md` — ta personnalite, ton ton, ta facon de penser",
  "  - `IDENTITY.md` — ton nom, emoji, description visible par l'utilisateur",
  "  - `USER.md` — informations sur l'utilisateur (prenom, preferences)",
  "  - `AGENTS.md` — les autres agents que tu connais",
  "  - `MEMORY.md` — notes persistantes a relire et mettre a jour",
  "  - `BOOTSTRAP.md` — checklist de demarrage (executee au premier message, supprimee ensuite)",
  "- Tu peux lire et modifier ces fichiers pour mettre a jour ta memoire ou ta persona.",
  "- Si le dossier `~/.agent/` n'existe pas, tu n'as pas de persona — reponds normalement.",
  "",
  "### Securite",
  "- Ne modifie JAMAIS les fichiers de config Claude (~/.claude/settings.json, ~/.claude.json, ~/.claude/mcp_servers.json).",
  "- Ne lance pas de commandes destructives (rm -rf, drop database) sans confirmation explicite.",
  "- Les credentials sont dans ~/.credentials/ — ne les affiche jamais en clair dans tes reponses.",
].join("\n");

/** Read persona files from .agent/ and build a persona system prompt section. */
async function buildPersonaPrompt(): Promise<string | null> {
  const AGENT_DIR = "/home/agent/.agent";
  const files = ["SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md", "MEMORY.md"];
  const sections: string[] = [];

  for (const file of files) {
    try {
      const f = Bun.file(`${AGENT_DIR}/${file}`);
      if (await f.exists()) {
        const content = await f.text();
        if (content.trim()) {
          sections.push(`## ${file}\n\n${content.trim()}`);
        }
      }
    } catch {}
  }

  if (sections.length === 0) return null;
  return "# Persona Agent\n\n" + sections.join("\n\n---\n\n");
}

/**
 * Write the system prompt (agent rules + persona) to CLAUDE.md.
 * The SDK loads this automatically as project instructions.
 * Called at daemon startup and when persona changes.
 */
export async function writeSystemPromptFile(): Promise<void> {
  let content = "";

  const personaPrompt = await buildPersonaPrompt();
  if (personaPrompt) {
    content = personaPrompt + "\n\n---\n\n";
    console.log("[runner] Persona enabled — writing to CLAUDE.md");
  }

  content += AGENT_SYSTEM_PROMPT;

  await Bun.write(CLAUDE_MD_FILE, content);
  console.log("[runner] CLAUDE.md written with system prompt");
}

// === Running prompt persistence (auto-resume after crash) ===

async function saveRunningPrompt(prompt: string): Promise<void> {
  try {
    await Bun.write(RUNNING_PROMPT_FILE, JSON.stringify({ prompt, startedAt: Date.now() }));
  } catch {}
}

async function clearRunningPrompt(): Promise<void> {
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(RUNNING_PROMPT_FILE);
  } catch {}
}

async function loadInterruptedPrompt(): Promise<string | null> {
  try {
    const file = Bun.file(RUNNING_PROMPT_FILE);
    if (!(await file.exists())) return null;
    const data = JSON.parse(await file.text());
    // Only resume if interrupted less than 1 hour ago
    if (Date.now() - data.startedAt > 60 * 60 * 1000) {
      await clearRunningPrompt();
      return null;
    }
    return data.prompt;
  } catch {
    return null;
  }
}

// === Session management ===

/**
 * Initialize the runner at daemon startup.
 * Sets cwd to /home/agent (SDK uses process.cwd() as project directory)
 * and writes the CLAUDE.md system prompt file.
 */
export async function initRunner(): Promise<void> {
  process.chdir("/home/agent");
  console.log("[runner] cwd set to /home/agent");

  await writeSystemPromptFile();
}

/**
 * Create or resume the SDK V2 session. Lazy — called on first message.
 */
async function ensureSession(): Promise<SDKSession> {
  if (session) return session;

  const existingSessionId = await loadSession();

  const options: Record<string, unknown> = {
    model: "claude-opus-4-6[1m]",
    permissionMode: "bypassPermissions",
  };

  if (existingSessionId) {
    console.log(`[runner] Resuming session ${existingSessionId.slice(0, 8)}...`);
    try {
      session = unstable_v2_resumeSession(existingSessionId, options as any);
      return session;
    } catch (err) {
      console.warn("[runner] Failed to resume session, creating new one:", err);
      await clearSession();
    }
  }

  console.log("[runner] Creating new SDK V2 session...");
  session = unstable_v2_createSession(options as any);
  return session;
}

// === API publique ===

/**
 * Retourne true si Claude Code est en cours d'execution.
 */
export function isBusy(): boolean {
  return isRunning;
}

/**
 * Check for an interrupted prompt and auto-resume it.
 * Called once at daemon startup after WS connection is established.
 */
export async function autoResume(): Promise<void> {
  const interrupted = await loadInterruptedPrompt();
  if (!interrupted) return;

  console.log(`[runner] Auto-resuming interrupted task: "${interrupted.slice(0, 80)}..."`);
  await clearRunningPrompt();

  // Small delay to let the daemon fully connect
  await new Promise((r) => setTimeout(r, 2000));

  runPrompt(
    `Tu as été interrompu pendant la tâche suivante. Continue exactement où tu en étais :\n\n${interrupted}`
  ).catch((err) => {
    console.error("[runner] Auto-resume failed:", err);
  });
}

/**
 * Gracefully interrupt the current stream.
 * The session stays intact — next send() continues in the same context.
 * No SIGKILL, no process death — just breaks the for-await loop.
 */
export function interruptCurrent(userKill = true): boolean {
  if (!isStreaming) return false;

  console.log(`[runner] Interrupting stream (userKill=${userKill})...`);
  userInitiatedInterrupt = userKill;
  streamAborted = true;

  if (userKill) {
    clearRunningPrompt().catch(() => {});
  }

  return true;
}

/**
 * Close the current session and force a new one on next message.
 * Used by /reload to get a fresh session with reloaded MCPs.
 */
export function resetSession(): void {
  console.log("[runner] Resetting session — next message creates a new one");
  if (isStreaming) {
    streamAborted = true;
  }
  try { session?.close(); } catch {}
  session = null;
  bootInjected = false;
  clearSession().catch(() => {});
}

/**
 * Gracefully close the session for daemon shutdown.
 */
export function closeSession(): void {
  if (isStreaming) {
    streamAborted = true;
  }
  try { session?.close(); } catch {}
  session = null;
}

// === Main prompt execution ===

/**
 * Send a prompt to Claude via SDK V2 session and stream the response.
 * Includes auto-continue for incomplete tasks and memory flush after completion.
 */
export async function runPrompt(prompt: string): Promise<void> {
  if (isRunning) {
    console.warn("[runner] Already running — ignoring new prompt");
    sendMessage({
      type: "error",
      code: "RUNNER_BUSY",
      message: "Claude Code is already processing a message",
    });
    return;
  }



  isRunning = true;
  resultReceived = false;
  userInitiatedInterrupt = false;
  streamAborted = false;
  lastResultText = "";
  lastResultIsError = false;
  eventCount = 0;
  autoContinueCount = 0;

  await saveRunningPrompt(prompt);
  sendMessage({ type: "status", status: "working" });

  let currentPrompt = prompt;

  // BOOTSTRAP.md — inject once per session as prefix to the first prompt
  if (!bootInjected) {
    try {
      const bootFile = Bun.file(BOOT_FILE);
      if (await bootFile.exists()) {
        const bootContent = (await bootFile.text()).trim();
        if (bootContent) {
          currentPrompt = `[Instructions de demarrage]\n${bootContent}\n\n[Message utilisateur]\n${prompt}`;
          console.log("[runner] BOOTSTRAP.md injected into first prompt");
        }
      }
    } catch {}
    bootInjected = true;
  }

  // Auto-continue loop: if Claude stops mid-task, send "continue" in the same session
  while (true) {
    try {
      await streamTurn(currentPrompt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[runner] Error during stream:", message);
      sendMessage({ type: "error", code: "RUNNER_ERROR", message });

      // If session is broken, reset it so the next message creates a fresh one
      if (message.includes("closed") || message.includes("spawn") || message.includes("ENOENT")) {
        console.warn("[runner] Session appears broken, resetting...");
        try { session?.close(); } catch {}
        session = null;
      }
      break;
    }

    // If killed by user or no result received, stop
    if (userInitiatedInterrupt || !resultReceived) break;

    // Check auto-continue limit
    if (autoContinueCount >= MAX_AUTO_CONTINUES) {
      console.warn("[runner] Max auto-continues reached, stopping");
      break;
    }

    // Detect if the task seems incomplete
    const needsContinue = !lastResultIsError && detectIncompleteTask(lastResultText);
    if (!needsContinue) {
      console.log(`[runner] Task complete — isError=${lastResultIsError}, events=${eventCount}, result=${lastResultText.slice(0, 100) || "(empty)"}`);
      break;
    }

    // Auto-continue: send a new message in the same session (no respawn!)
    autoContinueCount++;
    console.log(`[runner] Auto-continue ${autoContinueCount}/${MAX_AUTO_CONTINUES}`);
    resultReceived = false;
    lastResultText = "";
    lastResultIsError = false;
    eventCount = 0;
    streamAborted = false;
    currentPrompt = "Continue exactement ou tu en etais. Ne repete pas ce que tu as deja fait. Continue la tache.";
  }

  // Synthetic result if interrupted before result event
  if (!resultReceived) {
    sendMessage({ type: "stream_event", event: { type: "result", result: "", is_error: true, subtype: "error" } });
  }

  // Clear running prompt on normal completion or user kill
  if (resultReceived || userInitiatedInterrupt) {
    await clearRunningPrompt();
  }

  isRunning = false;
  sendMessage({ type: "status", status: "idle" });
}

// === Stream execution ===

/**
 * Execute a single send/stream turn on the persistent session.
 */
async function streamTurn(prompt: string): Promise<void> {
  const s = await ensureSession();

  console.log(`[runner] Sending: "${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}"`);

  await s.send(prompt);
  isStreaming = true;

  // Max runtime timeout for this turn
  const runtimeTimeout = setTimeout(() => {
    console.warn("[runner] Turn exceeded max runtime, interrupting...");
    interruptCurrent(false);
  }, MAX_TURN_MS);

  try {
    for await (const msg of s.stream()) {
      if (streamAborted) {
        console.log("[runner] Stream aborted (graceful interrupt)");
        break;
      }

      processSDKMessage(msg);
    }
  } finally {
    isStreaming = false;
    clearTimeout(runtimeTimeout);
  }
}

// === Event processing ===

/**
 * Process a single SDK message — forward to backend and track state.
 * SDK events have the same types as CLI NDJSON: assistant, user, result, system, stream_event.
 * They are wrapped in { type: "stream_event", event: msg } for the backend WS,
 * exactly like the old CLI runner did with NDJSON lines.
 */
function processSDKMessage(msg: SDKMessage): void {
  const event = msg as Record<string, unknown>;

  // Ensure SDKResultError has a `result` field for frontend compatibility.
  // SDKResultSuccess has result:string, but SDKResultError only has errors:string[].
  if (event.type === "result" && !("result" in event)) {
    const errors = Array.isArray(event.errors) ? event.errors : [];
    (event as any).result = errors.join("; ");
  }

  // Forward event to backend (same wrapping as the old CLI runner)
  sendMessage({ type: "stream_event", event });

  // Track event count for auto-continue detection
  const evType = event.type as string | undefined;
  if (evType && evType !== "result" && evType !== "system") {
    eventCount++;
  }

  // Track result events
  if (event.type === "result") {
    resultReceived = true;
    lastResultText = typeof event.result === "string" ? event.result : "";
    lastResultIsError = Boolean(event.is_error);

    // Save session ID for future resumption
    if (typeof event.session_id === "string") {
      saveSession(event.session_id).catch((err) => {
        console.error("[runner] Failed to save session:", err);
      });
    }
  }

  // Auth URL detection in text content
  extractAndSendAuthUrl(event);
}

// === Incomplete task detection ===

function detectIncompleteTask(resultText: string): boolean {
  // Empty result after many events = Claude stopped mid-task (tool-call limit)
  if (!resultText.trim() && eventCount >= 5) {
    console.log(`[runner] Detected premature stop: empty result after ${eventCount} events`);
    return true;
  }

  if (!resultText) return false;
  const lower = resultText.toLowerCase();

  const incompletePatterns = [
    // French — intent to continue / stopped mid-task
    "je vais continuer", "je poursuis",
    "voici les .* premiers",
    "je m'arrete ici", "je m'arrête ici",
    "voulez-vous que je continue", "veux-tu que je continue",
    "dois-je continuer",
    "suite au prochain",
    "il en reste", "il reste encore",
    "je n'ai pas encore fini", "pas encore termine",
    "j'ai fait .* sur", "j'ai traite .* sur",
    // English — intent to continue / stopped mid-task
    "i'll continue", "shall i continue", "should i continue",
    "want me to continue", "let me continue",
    "here are the first", "i've done .* out of",
    "i stopped", "i'll proceed",
  ];

  return incompletePatterns.some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(lower);
    } catch {
      return lower.includes(pattern);
    }
  });
}

// === Auth URL detection ===

function extractAndSendAuthUrl(event: Record<string, unknown>): void {
  const textsToCheck: string[] = [];

  // Event system (init, messages)
  if (typeof event.message === "string") {
    textsToCheck.push(event.message);
  }

  // Event assistant avec content blocks
  if (event.type === "assistant" && event.message && typeof event.message === "object") {
    const msg = event.message as { content?: Array<{ type?: string; text?: string }> };
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text" && typeof block.text === "string") {
          textsToCheck.push(block.text);
        }
      }
    }
  }

  // Event result
  if (event.type === "result" && typeof event.result === "string") {
    textsToCheck.push(event.result);
  }

  // Event system subtype data
  if (typeof event.subtype === "string" && typeof event.data === "string") {
    textsToCheck.push(event.data);
  }

  // SDK auth_status events
  if (event.type === "auth_status" && Array.isArray(event.output)) {
    for (const line of event.output) {
      if (typeof line === "string") textsToCheck.push(line);
    }
  }

  for (const text of textsToCheck) {
    checkForAuthUrl(text);
  }
}

function checkForAuthUrl(text: string): void {
  const match = text.match(AUTH_URL_PATTERN);
  if (match) {
    const url = match[0];
    console.log(`[runner] Auth URL detected: ${url}`);
    sendMessage({ type: "auth_link", url });
  }
}
