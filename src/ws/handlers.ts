// src/ws/handlers.ts
// Handlers pour les messages inbound recus du backend.

import type { DaemonInboundMessage } from "./types.ts";
import { runPrompt, killActive } from "../claude/runner.ts";
import { clearSession } from "../claude/session.ts";
import { sendMessage } from "./client.ts";

/**
 * Route un message inbound du backend vers le handler correspondant.
 */
export function handleInboundMessage(msg: DaemonInboundMessage): void {
  switch (msg.type) {
    case "inject_message":
      handleInjectMessage(msg.content, msg.attachments);
      break;

    case "exec":
      handleExec(msg.requestId, msg.command);
      break;

    case "kill":
      handleKill();
      break;

    case "clipboard_set":
      handleClipboardSet(msg.text);
      break;

    default: {
      // Exhaustive check — compile error si un type est oublie
      const _exhaustive: never = msg;
      console.warn(`[handlers] Unknown message type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * Injecte un message dans Claude Code via le runner.
 * Lance Claude Code en arriere-plan (fire-and-forget).
 */
function handleInjectMessage(content: string, attachments?: string[]): void {
  console.log(`[handlers] inject_message received (content length: ${content.length}, attachments: ${attachments?.length ?? 0})`);

  const cmd = content.trim();

  // Blocked slash commands — not available in AgentWay
  const blockedCommands = ["/clear", "/resume", "/fork"];
  if (blockedCommands.includes(cmd)) {
    console.log(`[handlers] Blocked command: ${cmd}`);
    sendMessage({
      type: "stream_event",
      event: {
        type: "result",
        result: `La commande ${cmd} n'est pas disponible dans AgentWay.`,
        is_error: true,
      },
    });
    sendMessage({ type: "status", status: "active" });
    return;
  }

  // /reload — kill active process, clear session, start fresh
  // Claude Code's session memory auto-saves summaries, so a new session
  // will automatically load past context. MCPs are reloaded on fresh start.
  if (cmd === "/reload") {
    console.log("[handlers] /reload command received — resetting session");
    killActive();
    clearSession().then(() => {
      sendMessage({
        type: "stream_event",
        event: {
          type: "result",
          result: "Session rechargée. La prochaine commande démarrera une nouvelle conversation avec les MCPs rechargés.",
          is_error: false,
        },
      });
      sendMessage({ type: "status", status: "active" });
    });
    return;
  }

  let prompt = content;
  if (attachments && attachments.length > 0) {
    // Filter attachment paths to prevent path traversal
    const safePaths = attachments.filter((p) =>
      typeof p === "string" && !p.includes("..") && !p.startsWith("/")
    );
    if (safePaths.length > 0) {
      const attachmentLines = safePaths.map((path) => `[Attached file: ${path}]`).join("\n");
      prompt = `${content}\n\n${attachmentLines}`;
    }
  }

  // Fire-and-forget : le runner gere les statuts et les erreurs
  runPrompt(prompt).catch((error) => {
    console.error("[handlers] Unhandled error in runPrompt:", error);
  });
}

/** Maximum exec command runtime (30 seconds). */
const EXEC_TIMEOUT_MS = 30_000;

/** Maximum output size per exec (1MB). */
const EXEC_MAX_OUTPUT = 1024 * 1024;

/** Concurrency guard — only one exec at a time. */
let execRunning = false;

/**
 * Execute a command locally and send the result back to the backend.
 * Protected with timeout, output limit, and concurrency guard.
 */
async function handleExec(requestId: string, command: string): Promise<void> {
  if (execRunning) {
    sendMessage({ type: "exec_result", requestId, stdout: "", stderr: "Another exec is already running", exitCode: 1 });
    return;
  }

  // Validate command length
  if (command.length > 10_000) {
    sendMessage({ type: "exec_result", requestId, stdout: "", stderr: "Command too long (max 10000 chars)", exitCode: 1 });
    return;
  }

  execRunning = true;
  console.log(`[handlers] exec received (requestId: ${requestId}, cmd: ${command.slice(0, 80)}...)`);

  try {
    const proc = Bun.spawn(["bash", "-c", command], {
      stdout: "pipe",
      stderr: "pipe",
    });

    // Timeout: kill process if it takes too long
    const timeout = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
    }, EXEC_TIMEOUT_MS);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text().then((s) => s.slice(0, EXEC_MAX_OUTPUT)),
      new Response(proc.stderr).text().then((s) => s.slice(0, EXEC_MAX_OUTPUT)),
    ]);
    await proc.exited;
    clearTimeout(timeout);

    sendMessage({ type: "exec_result", requestId, stdout, stderr, exitCode: proc.exitCode ?? 1 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendMessage({ type: "exec_result", requestId, stdout: "", stderr: msg, exitCode: 1 });
  } finally {
    execRunning = false;
  }
}

/**
 * Envoie SIGTERM au processus Claude Code en cours.
 */
function handleKill(): void {
  console.log("[handlers] kill received — sending SIGTERM to Claude Code process");
  const killed = killActive();
  if (!killed) {
    console.log("[handlers] No active Claude Code process to kill");
  }
}

/**
 * Set the X11 clipboard via xclip.
 * Runs independently of exec (no concurrency guard) so it works
 * even while Claude Code is running.
 */
async function handleClipboardSet(text: string): Promise<void> {
  try {
    const proc = Bun.spawn(
      ["bash", "-c", `DISPLAY=:1 XAUTHORITY=$HOME/.Xauthority xclip -selection clipboard`],
      { stdin: new TextEncoder().encode(text), stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
    if (proc.exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.warn(`[handlers] clipboard_set failed: ${stderr}`);
    } else {
      console.log(`[handlers] clipboard_set: ${text.length} chars`);
    }
  } catch (err) {
    console.error("[handlers] clipboard_set error:", err);
  }
}
