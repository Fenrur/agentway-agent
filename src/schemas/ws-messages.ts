// src/schemas/ws-messages.ts
// Zod schemas for Backend -> Daemon WebSocket messages (inbound to the agent).

import { z } from "zod";

// === Backend -> Daemon (inbound to agent) ===

export const injectMessageSchema = z.object({
  type: z.literal("inject_message"),
  content: z.string(),
  attachments: z.array(z.string()).optional(),
});

export const execSchema = z.object({
  type: z.literal("exec"),
  requestId: z.string(),
  command: z.string(),
});

export const killSchema = z.object({
  type: z.literal("kill"),
});

export const clipboardSetSchema = z.object({
  type: z.literal("clipboard_set"),
  text: z.string(),
});

export const daemonInboundMessageSchema = z.discriminatedUnion("type", [
  injectMessageSchema,
  execSchema,
  killSchema,
  clipboardSetSchema,
]);

export type DaemonInboundMessage = z.infer<typeof daemonInboundMessageSchema>;

// === Backend -> Agent responses (auth flow) ===

export const authOkSchema = z.object({
  type: z.literal("auth_ok"),
});

export const errorSchema = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
});

/** All possible messages the agent can receive from the backend */
export const backendToAgentMessageSchema = z.discriminatedUnion("type", [
  injectMessageSchema,
  execSchema,
  killSchema,
  clipboardSetSchema,
  authOkSchema,
  errorSchema,
]);

export type BackendToAgentMessage = z.infer<typeof backendToAgentMessageSchema>;
