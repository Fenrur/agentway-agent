// src/ws/types.ts
// Types pour les messages WebSocket entre le daemon et le backend.

// === Messages Backend -> Daemon (inbound) ===

export type DaemonInboundMessage =
  | { type: "inject_message"; content: string; attachments?: string[] }
  | { type: "exec"; requestId: string; command: string }
  | { type: "kill" };

// === Messages Daemon -> Backend (outbound) ===

export type DaemonOutboundMessage =
  | { type: "daemon_connected" }
  | { type: "stream_event"; event: unknown }
  | { type: "status"; status: "idle" | "working" }
  | { type: "auth_link"; url: string }
  | { type: "skills_update"; skills: Array<{ name: string; description: string; source: string }> }
  | { type: "exec_result"; requestId: string; stdout: string; stderr: string; exitCode: number }
  | { type: "error"; code: string; message: string };

// === Union ===

export type DaemonMessage = DaemonInboundMessage | DaemonOutboundMessage;
