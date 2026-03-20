// src/index.ts
// Entry point du daemon agentway-agent.
// Se connecte au backend via WebSocket au demarrage.

import { config } from "./config.ts";
import { connect, disconnect } from "./ws/client.ts";
import { startSkillsWatcher } from "./skills/watcher.ts";

console.log(`agentway-agent daemon started`);
console.log(`Backend WebSocket URL: ${config.backendWsUrl}`);

// Connecter le WebSocket client au backend
connect(config.backendWsUrl, config.daemonToken);

// Start watching for skills/commands changes
startSkillsWatcher();

// Gerer l'arret propre (SIGTERM de systemd, SIGINT de Ctrl+C)
function gracefulShutdown(signal: string) {
  console.log(`[daemon] Received ${signal}, shutting down...`);
  disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
