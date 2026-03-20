// src/claude/runner.ts
// Coeur du daemon : spawn Claude Code CLI, capture stdout NDJSON,
// detecte le lien d'auth, forward les events au backend.
//
// Pattern inspire de ClaudeClaw runner.ts :
//   Bun.spawn + proc.stdout.getReader() + NDJSON parsing line par line.

import { sendMessage } from "../ws/client.ts";
import { loadSession, saveSession } from "./session.ts";

// === Constantes ===

/** Grace period entre SIGTERM et SIGKILL (ms) */
const SIGKILL_GRACE_MS = 5_000;

/** Maximum execution time for a single Claude Code run (30 minutes) */
const MAX_RUNTIME_MS = 30 * 60 * 1000;

/** Pattern pour detecter un lien d'auth dans le texte */
const AUTH_URL_PATTERN = /https?:\/\/[^\s"'<>]*(?:claude\.ai|anthropic\.com)[^\s"'<>]*/i;

// === State ===

/** Process Claude Code en cours d'execution */
let activeProc: ReturnType<typeof Bun.spawn> | null = null;

/** Lecteur stdout actif — annule immediatement lors du kill */
let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

/** Indique si le runner est en train de traiter un message */
let isRunning = false;

/** Indique si un event "result" a ete recu pendant le run courant */
let resultReceived = false;

// === API publique ===

/**
 * Retourne true si Claude Code est en cours d'execution.
 */
export function isBusy(): boolean {
  return isRunning;
}

/**
 * Tue le processus Claude Code en cours.
 * Envoie SIGTERM puis SIGKILL apres un delai de grace.
 * Retourne true si un processus a ete tue.
 */
export function killActive(): boolean {
  if (!activeProc) return false;

  console.log("[runner] Killing active Claude Code process...");
  const proc = activeProc;

  // Annuler le reader stdout immediatement pour debloquer readNdjsonStream
  // (sinon reader.read() reste bloque jusqu'au SIGKILL 5s plus tard)
  try { activeReader?.cancel(); } catch {}

  try {
    proc.kill("SIGTERM");
  } catch {
    // Processus deja mort
  }

  // SIGKILL apres la grace period
  setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Deja mort
    }
  }, SIGKILL_GRACE_MS);

  // Note: isRunning is reset in the finally block of runPrompt()
  // when proc.exited resolves after SIGTERM/SIGKILL
  return true;
}

/**
 * Lance Claude Code avec un prompt et capture le flux NDJSON.
 *
 * Workflow :
 *   1. Envoie status "working" au backend
 *   2. Spawn Claude Code avec Bun.spawn
 *   3. Lit stdout en streaming via getReader()
 *   4. Parse chaque ligne JSON (NDJSON)
 *   5. Detecte le lien d'auth s'il existe dans le texte
 *   6. Forward chaque event au backend via stream_event
 *   7. Envoie status "idle" a la fin
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

  // Notifier le backend : on travaille
  sendMessage({ type: "status", status: "working" });

  try {
    await spawnClaude(prompt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[runner] Error running Claude Code:", message);
    sendMessage({ type: "error", code: "RUNNER_ERROR", message });
  } finally {
    isRunning = false;
    activeProc = null;

    // Si Claude a ete interrompu avant d'envoyer un event "result" (kill),
    // envoyer un result synthetique pour que l'UI nettoie isStreaming/isWaiting.
    if (!resultReceived) {
      sendMessage({ type: "stream_event", event: { type: "result", result: "", is_error: true, subtype: "error" } });
    }

    // Notifier le backend : on est idle
    sendMessage({ type: "status", status: "idle" });
  }
}

// === Internals ===

/**
 * Spawn Claude Code et traite le flux NDJSON.
 */
async function spawnClaude(prompt: string): Promise<void> {
  // Construire les arguments CLI
  const args = [
    "claude",
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
  ];

  // Charger la session existante pour --resume
  const existingSessionId = await loadSession();
  if (existingSessionId) {
    args.push("--resume", existingSessionId);
    console.log(`[runner] Resuming session ${existingSessionId.slice(0, 8)}...`);
  } else {
    console.log("[runner] Starting new Claude Code session");
  }

  console.log(`[runner] Spawning: claude -p "${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}"`);

  // Spawn le processus
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });

  activeProc = proc;

  // Max runtime timeout
  const runtimeTimeout = setTimeout(() => {
    console.warn("[runner] Claude Code exceeded max runtime, killing...");
    killActive();
  }, MAX_RUNTIME_MS);

  // Lire stderr en parallele (pour les logs)
  const stderrPromise = new Response(proc.stderr as ReadableStream).text();

  // Lire stdout en streaming NDJSON
  const stdout = proc.stdout as ReadableStream<Uint8Array>;
  await readNdjsonStream(stdout);

  // Attendre la fin du processus
  await proc.exited;
  clearTimeout(runtimeTimeout);

  const exitCode = proc.exitCode ?? 1;
  const stderr = await stderrPromise;

  if (stderr.trim()) {
    console.warn(`[runner] stderr: ${stderr.trim().slice(0, 200)}`);
  }

  if (exitCode !== 0) {
    console.warn(`[runner] Claude Code exited with code ${exitCode}`);
  }
}

/**
 * Lit le flux stdout NDJSON d'un processus Claude Code.
 * Parse chaque ligne, detecte les liens d'auth, forward les events.
 */
async function readNdjsonStream(stdout: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stdout.getReader();
  activeReader = reader;
  const decoder = new TextDecoder();
  let buffer = "";

  try {
  while (true) {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await reader.read();
    } catch {
      // Reader cancelled (kill signal) — sortie propre
      break;
    }
    const { done, value } = result;
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Traiter chaque ligne complete
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);

      if (!line) continue;

      processNdjsonLine(line);
    }
  }

  // Traiter le reste du buffer s'il y en a
  const remaining = buffer.trim();
  if (remaining) {
    processNdjsonLine(remaining);
  }
  } finally {
    activeReader = null;
    try { reader.releaseLock(); } catch {}
  }
}

/**
 * Traite une seule ligne NDJSON de Claude Code.
 */
function processNdjsonLine(line: string): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line);
  } catch {
    // Pas du JSON — peut etre un message texte brut (ex: lien d'auth avant JSON)
    checkForAuthUrl(line);
    return;
  }

  // Forward l'event brut au backend
  sendMessage({ type: "stream_event", event });

  // Marquer que le result a ete recu (run normal, pas interrompu)
  if (event.type === "result") {
    resultReceived = true;
  }

  // Extraire le session ID de l'event "result"
  if (event.type === "result" && typeof event.session_id === "string") {
    saveSession(event.session_id).catch((err) => {
      console.error("[runner] Failed to save session:", err);
    });
  }

  // Chercher un lien d'auth dans le contenu textuel des events
  extractAndSendAuthUrl(event);
}

/**
 * Extrait un lien d'auth depuis un event NDJSON.
 *
 * Le lien d'auth peut apparaitre dans :
 *   - Un event de type "system" avec un message texte
 *   - Un event de type "assistant" avec du contenu text
 *   - Un event de type "result" avec le result text
 *   - La sortie stderr/text brute
 */
function extractAndSendAuthUrl(event: Record<string, unknown>): void {
  // Chercher dans le texte de l'event
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

  // Event system subtype
  if (typeof event.subtype === "string" && typeof event.data === "string") {
    textsToCheck.push(event.data);
  }

  // Verifier chaque texte pour un lien d'auth
  for (const text of textsToCheck) {
    checkForAuthUrl(text);
  }
}

/**
 * Verifie si un texte contient un lien d'auth Claude et l'envoie au backend.
 */
function checkForAuthUrl(text: string): void {
  const match = text.match(AUTH_URL_PATTERN);
  if (match) {
    const url = match[0];
    console.log(`[runner] Auth URL detected: ${url}`);
    sendMessage({ type: "auth_link", url });
  }
}
