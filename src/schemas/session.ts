import { z } from "zod";

export const SessionDataSchema = z.object({
  sessionId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type SessionData = z.infer<typeof SessionDataSchema>;
