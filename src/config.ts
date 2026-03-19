// src/config.ts
// Bun charge automatiquement .env, pas besoin de dotenv.

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error(`FATAL: Missing required environment variable: ${key}`);
    process.exit(1);
  }
  return value;
}

export const config = {
  /** URL WebSocket du backend (ex: ws://192.168.1.100:3000) */
  backendWsUrl: requireEnv("BACKEND_WS_URL"),

  /** Identifiant unique de cet agent (fourni par cloud-init) */
  agentId: requireEnv("AGENT_ID"),

  /** Token d'authentification pour la connexion daemon -> backend */
  daemonToken: requireEnv("DAEMON_TOKEN"),
} as const;
