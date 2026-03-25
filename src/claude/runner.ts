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

/** Watchdog interval: check every 5s if the process died without cleanup */
const WATCHDOG_INTERVAL_MS = 5_000;

// === State ===

/** Process Claude Code en cours d'execution */
let activeProc: ReturnType<typeof Bun.spawn> | null = null;

/** Lecteur stdout actif — annule immediatement lors du kill */
let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

/** Indique si le runner est en train de traiter un message */
let isRunning = false;

/** Indique si un event "result" a ete recu pendant le run courant */
let resultReceived = false;

/** Watchdog timer */
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

/** File to track the currently running prompt for auto-resume after crash/restart */
const RUNNING_PROMPT_FILE = "/opt/agentway-agent/running_prompt.json";

/** Save the current prompt so it can be resumed after a crash */
async function saveRunningPrompt(prompt: string): Promise<void> {
  try {
    await Bun.write(RUNNING_PROMPT_FILE, JSON.stringify({ prompt, startedAt: Date.now() }));
  } catch {}
}

/** Clear the running prompt (task completed or explicitly killed by user) */
async function clearRunningPrompt(): Promise<void> {
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(RUNNING_PROMPT_FILE);
  } catch {}
}

/** Load a previously interrupted prompt for auto-resume */
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

/** Whether the current kill was user-initiated (don't auto-resume) */
let userInitiatedKill = false;

/** Tracks whether BOOT.md has been injected in this daemon session. */
let bootInjected = false;

/** Path to BOOT.md checklist file. */
const BOOT_FILE = "/home/agent/.agent/BOOT.md";

/** Memory flush prompt — sent after task completion to save important facts. */
const MEMORY_FLUSH_PROMPT = "Sauvegarde les faits importants de cette conversation dans ta memoire claude-mem (smart_search, observations). Resume en 2-3 phrases ce qui s'est passe, les decisions prises, et les informations a retenir pour les prochaines sessions. Sois bref.";

// === Watchdog ===

/**
 * Starts a watchdog that checks every 5s if isRunning is true but
 * activeProc is dead. This catches edge cases where the process dies
 * without the finally block cleaning up (OOM kill, zombie, crash).
 */
function startWatchdog(): void {
  stopWatchdog();
  watchdogTimer = setInterval(() => {
    if (!isRunning) return;

    // Check if the process object exists but has already exited
    if (activeProc && activeProc.exitCode !== null) {
      console.warn(`[runner] Watchdog: process exited (code ${activeProc.exitCode}) but isRunning=true — forcing cleanup`);
      isRunning = false;
      activeProc = null;

      if (!resultReceived) {
        sendMessage({ type: "stream_event", event: { type: "result", result: "", is_error: true, subtype: "error" } });
      }
      sendMessage({ type: "status", status: "idle" });
      stopWatchdog();
    }

    // Check if there's no process at all but isRunning is stuck
    if (!activeProc && isRunning) {
      console.warn("[runner] Watchdog: no process but isRunning=true — forcing cleanup");
      isRunning = false;

      if (!resultReceived) {
        sendMessage({ type: "stream_event", event: { type: "result", result: "", is_error: true, subtype: "error" } });
      }
      sendMessage({ type: "status", status: "idle" });
      stopWatchdog();
    }
  }, WATCHDOG_INTERVAL_MS);
}

function stopWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
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
  await clearRunningPrompt(); // Clear before resume to avoid infinite retry loops

  // Small delay to let the daemon fully connect
  await new Promise((r) => setTimeout(r, 2000));

  // Resume with --continue (loads session context) + a resume prompt
  runPrompt(
    `Tu as été interrompu pendant la tâche suivante. Continue exactement où tu en étais :\n\n${interrupted}`
  ).catch((err) => {
    console.error("[runner] Auto-resume failed:", err);
  });
}

/**
 * Interrompt le processus Claude Code en cours.
 *
 * Strategy: SIGINT → SIGTERM → SIGKILL (escalation)
 * - SIGINT: Claude Code interprets this as "stop current task" (like Esc/Ctrl+C)
 *   and returns a result event gracefully, preserving the session.
 * - SIGTERM: If SIGINT didn't work after 5s, force terminate.
 * - SIGKILL: Last resort after another 5s.
 */
export function killActive(userKill = true): boolean {
  if (!activeProc) return false;

  console.log(`[runner] Killing active Claude Code process (userKill=${userKill})...`);
  userInitiatedKill = userKill;

  // If user-initiated kill, clear the running prompt so it won't auto-resume
  if (userKill) {
    clearRunningPrompt().catch(() => {});
  }

  const proc = activeProc;

  // Cancel reader immediately to unblock readNdjsonStream
  try { activeReader?.cancel(); } catch {}

  // SIGKILL immediately — Claude Code in -p mode doesn't handle SIGINT/SIGTERM gracefully.
  // Session is preserved via --continue flag on next run (no session ID needed).
  try {
    proc.kill("SIGKILL");
  } catch {
    // Process already dead
  }

  // Fallback SIGKILL in case the first one didn't work
  setTimeout(() => {
    try {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    } catch {}
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
  userInitiatedKill = false;

  // Save the prompt so it can be auto-resumed after daemon restart
  await saveRunningPrompt(prompt);

  // Notifier le backend : on travaille
  sendMessage({ type: "status", status: "working" });

  // Start watchdog to catch process crashes
  startWatchdog();

  try {
    await spawnClaude(prompt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[runner] Error running Claude Code:", message);
    sendMessage({ type: "error", code: "RUNNER_ERROR", message });
  } finally {
    isRunning = false;
    activeProc = null;
    stopWatchdog();

    // Si Claude a ete interrompu avant d'envoyer un event "result" (kill),
    // envoyer un result synthetique pour que l'UI nettoie isStreaming/isWaiting.
    if (!resultReceived) {
      sendMessage({ type: "stream_event", event: { type: "result", result: "", is_error: true, subtype: "error" } });
    }

    // Clear running prompt if task completed normally (result received)
    // or if user explicitly killed it. Keep it for auto-resume on crash/restart.
    if (resultReceived || userInitiatedKill) {
      await clearRunningPrompt();
    }

    // Memory flush — after normal completion, ask Claude to save important facts
    // to claude-mem. Silent fire-and-forget, doesn't block the user.
    if (resultReceived && !userInitiatedKill) {
      memoryFlush().catch((err) => {
        console.warn("[runner] Memory flush failed:", err);
      });
    }

    // Notifier le backend : on est idle
    sendMessage({ type: "status", status: "idle" });
  }
}

/**
 * Memory flush — silently ask Claude to save important facts from the
 * conversation into claude-mem. Fire-and-forget, doesn't stream to UI.
 */
async function memoryFlush(): Promise<void> {
  console.log("[runner] Memory flush — saving conversation facts to claude-mem...");

  try {
    const proc = Bun.spawn([
      "claude",
      "-p",
      MEMORY_FLUSH_PROMPT,
      "--continue",
      "--dangerously-skip-permissions",
      "--output-format", "json",
      "--max-turns", "3",
    ], {
      cwd: "/home/agent",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Kill orphan MCP processes first
    try { Bun.spawnSync(["pkill", "-f", "chrome-devtools-mcp"], { stdout: "ignore", stderr: "ignore" }); } catch {}

    const exitCode = await proc.exited;
    console.log(`[runner] Memory flush completed (exit ${exitCode})`);
  } catch (err) {
    console.warn("[runner] Memory flush error:", err);
  }
}

// === Internals ===

/**
 * Spawn Claude Code et traite le flux NDJSON.
 */
/** System prompt appended to every Claude Code invocation. */
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
  "### Securite",
  "- Ne modifie JAMAIS les fichiers de config Claude (~/.claude/settings.json, ~/.claude.json, ~/.claude/mcp_servers.json).",
  "- Ne lance pas de commandes destructives (rm -rf, drop database) sans confirmation explicite.",
  "- Les credentials sont dans ~/.credentials/ — ne les affiche jamais en clair dans tes reponses.",
].join("\n");

/** Read persona files from .agent/ and build a persona system prompt section. */
async function buildPersonaPrompt(): Promise<string | null> {
  const AGENT_DIR = "/home/agent/.agent";
  const files = ["SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md", "TOOLS.md", "MEMORY.md"];
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

async function spawnClaude(prompt: string): Promise<void> {
  // Build system prompt: base rules + optional persona
  let systemPrompt = AGENT_SYSTEM_PROMPT;
  const personaPrompt = await buildPersonaPrompt();
  if (personaPrompt) {
    systemPrompt = personaPrompt + "\n\n---\n\n" + systemPrompt;
    console.log("[runner] Persona enabled — injecting persona files into system prompt");
  }

  // BOOT.md — inject once per daemon session as prefix to the first prompt
  let finalPrompt = prompt;
  if (!bootInjected) {
    try {
      const bootFile = Bun.file(BOOT_FILE);
      if (await bootFile.exists()) {
        const bootContent = (await bootFile.text()).trim();
        if (bootContent) {
          finalPrompt = `[Instructions de demarrage]\n${bootContent}\n\n[Message utilisateur]\n${prompt}`;
          console.log("[runner] BOOT.md injected into first prompt");
        }
      }
    } catch {}
    bootInjected = true;
  }

  // Construire les arguments CLI
  const args = [
    "claude",
    "-p",
    finalPrompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--include-partial-messages",
    "--append-system-prompt",
    systemPrompt,
  ];

  // Always use --continue to pick up the most recent session.
  // This works even after SIGKILL because Claude Code persists sessions to disk.
  // Only skip --continue on the very first message (no project dir yet).
  const projectDir = "/home/agent/.claude/projects/-home-agent";
  let hasExistingSession = false;
  try {
    const entries = await import("node:fs/promises").then((fs) => fs.readdir(projectDir));
    hasExistingSession = entries.some((e) => e.endsWith(".jsonl"));
  } catch {
    // Dir doesn't exist = no previous session
  }

  if (hasExistingSession) {
    args.push("--continue");
    console.log("[runner] Continuing most recent session...");
  } else {
    console.log("[runner] Starting new Claude Code session (first message)");
  }

  // Kill orphan MCP processes from previous Claude Code sessions.
  // Claude Code spawns MCP subprocesses (chrome-devtools-mcp, etc.) that
  // survive SIGKILL and accumulate, leaking ~500MB each.
  try {
    Bun.spawnSync(["pkill", "-f", "chrome-devtools-mcp"], { stdout: "ignore", stderr: "ignore" });
  } catch {}


  console.log(`[runner] Spawning: claude -p "${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}"`);

  // Spawn le processus dans le home de l'agent (pas dans /opt/agentway-agent)
  const proc = Bun.spawn(args, {
    cwd: "/home/agent",
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
