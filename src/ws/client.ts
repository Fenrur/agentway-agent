// src/ws/client.ts
// WebSocket client vers le backend avec reconnexion exponential backoff.

import type { DaemonInboundMessage, DaemonOutboundMessage } from "./types.ts";
import { handleInboundMessage } from "./handlers.ts";

// === Constantes reconnexion ===

const INITIAL_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;

// === State ===

let ws: WebSocket | null = null;
let reconnectDelay = INITIAL_DELAY_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let intentionalClose = false;

/**
 * Construit l'URL WebSocket complete avec query params d'authentification.
 */
function buildWsUrl(backendWsUrl: string): string {
  const base = backendWsUrl.replace(/\/$/, "");
  return `${base}/ws/daemon`;
}

/**
 * Envoie un message au backend via WebSocket.
 * Retourne true si le message a ete envoye, false si le socket est ferme.
 */
export function sendMessage(message: DaemonOutboundMessage): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn("[ws-client] Cannot send message — WebSocket not connected");
    return false;
  }

  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch (error) {
    console.error("[ws-client] Failed to send message:", error);
    return false;
  }
}

/**
 * Planifie une reconnexion avec exponential backoff.
 */
function scheduleReconnect(
  backendWsUrl: string,
  token: string,
): void {
  if (intentionalClose) return;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }

  console.log(`[ws-client] Reconnecting in ${reconnectDelay}ms...`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect(backendWsUrl, token);
  }, reconnectDelay);

  // Augmenter le delai pour la prochaine tentative (exponential backoff)
  reconnectDelay = Math.min(reconnectDelay * BACKOFF_MULTIPLIER, MAX_DELAY_MS);
}

/**
 * Connecte le daemon au backend via WebSocket.
 *
 * Workflow :
 *   1. Ouvre la connexion vers /ws/daemon?token=...
 *   2. A l'ouverture : envoie daemon_connected, reset le backoff
 *   3. A la reception : parse le JSON et route vers les handlers
 *   4. A la fermeture/erreur : planifie une reconnexion
 */
export function connect(
  backendWsUrl: string,
  token: string,
): void {
  // Fermer proprement une connexion existante
  if (ws) {
    try {
      ws.close();
    } catch {
      // Ignorer — le socket est peut-etre deja ferme
    }
    ws = null;
  }

  const url = buildWsUrl(backendWsUrl);
  console.log(`[ws-client] Connecting to ${backendWsUrl}/ws/daemon ...`);

  intentionalClose = false;

  try {
    ws = new WebSocket(url);
  } catch (error) {
    console.error("[ws-client] Failed to create WebSocket:", error);
    scheduleReconnect(backendWsUrl, token);
    return;
  }

  ws.addEventListener("open", () => {
    console.log("[ws-client] Connected, authenticating...");

    // Reset le backoff apres une connexion reussie
    reconnectDelay = INITIAL_DELAY_MS;

    // First-message auth: send token immediately
    ws?.send(JSON.stringify({ type: "auth", token }));
  });

  ws.addEventListener("message", (event) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof event.data === "string" ? event.data : "");
    } catch {
      console.warn("[ws-client] Received non-JSON message, ignoring");
      return;
    }

    if (!msg || typeof msg !== "object" || !("type" in msg)) {
      console.warn("[ws-client] Received message without type field, ignoring");
      return;
    }

    // Handle auth_ok response — send daemon_connected after successful auth
    if (msg.type === "auth_ok") {
      console.log("[ws-client] Authenticated successfully");
      sendMessage({ type: "daemon_connected" });
      return;
    }

    if (msg.type === "error") {
      console.error(`[ws-client] Server error: ${msg.code} — ${msg.message}`);
      return;
    }

    handleInboundMessage(msg as DaemonInboundMessage);
  });

  ws.addEventListener("close", (event) => {
    console.log(`[ws-client] Disconnected (code: ${event.code}, reason: ${event.reason || "none"})`);
    ws = null;

    scheduleReconnect(backendWsUrl, token);
  });

  ws.addEventListener("error", (event) => {
    // L'event "error" est toujours suivi de "close" dans le spec WebSocket.
    // On log l'erreur mais on ne reconnecte pas ici — close le fera.
    console.error("[ws-client] WebSocket error:", event);
  });
}

/**
 * Ferme proprement la connexion WebSocket.
 * Annule les tentatives de reconnexion en cours.
 */
export function disconnect(): void {
  intentionalClose = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (ws) {
    try {
      ws.close(1000, "daemon shutdown");
    } catch {
      // Ignorer
    }
    ws = null;
  }

  console.log("[ws-client] Disconnected (intentional)");
}

/**
 * Retourne true si le WebSocket est actuellement connecte.
 */
export function isConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}
