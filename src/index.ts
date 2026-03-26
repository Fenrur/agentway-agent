// src/index.ts
// Entry point du daemon agentway-agent.
// Se connecte au backend via WebSocket au demarrage.

import { config } from "./config.ts";
import { connect, disconnect } from "./ws/client.ts";
import { startSkillsWatcher } from "./skills/watcher.ts";
import { startPersonaWatcher } from "./persona/watcher.ts";
import { initRunner, autoResume, closeSession, interruptCurrent } from "./claude/runner.ts";

console.log(`agentway-agent daemon started`);
console.log(`Backend WebSocket URL: ${config.backendWsUrl}`);

// Initialize the runner (sets cwd, writes CLAUDE.md system prompt)
await initRunner();

// Connecter le WebSocket client au backend
connect(config.backendWsUrl, config.daemonToken);

// Start watching for skills/commands changes
startSkillsWatcher();

// Auto-resume interrupted tasks after daemon restart.
// Wait 15s for WS connection + ensures/migrations to complete before resuming.
setTimeout(() => {
  autoResume().catch((err) => {
    console.error("[daemon] Auto-resume error:", err);
  });
}, 15_000);

// Start watching for persona file changes (.agent/IDENTITY.md, BOOTSTRAP.md)
startPersonaWatcher();

// Gerer l'arret propre (SIGTERM de systemd, SIGINT de Ctrl+C)
function gracefulShutdown(signal: string) {
  console.log(`[daemon] Received ${signal}, shutting down...`);
  interruptCurrent(false); // Not user-initiated — keep running_prompt for auto-resume
  closeSession(); // Clean SDK session close
  disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
