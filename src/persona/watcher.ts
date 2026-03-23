// src/persona/watcher.ts
// Watches .agent/IDENTITY.md for changes and BOOTSTRAP.md for deletion.
// Syncs persona name/emoji back to the backend via WebSocket.

import { watch, existsSync } from "node:fs";
import { sendMessage } from "../ws/client.ts";

const AGENT_DIR = "/home/agent/.agent";
const IDENTITY_PATH = `${AGENT_DIR}/IDENTITY.md`;
const BOOTSTRAP_PATH = `${AGENT_DIR}/BOOTSTRAP.md`;

/** Extract a field value from IDENTITY.md markdown content. */
function extractField(content: string, field: string): string | null {
  // Matches patterns like "- **Nom :** value" or "- **Nom:** value"
  const regex = new RegExp(`\\*\\*${field}\\s*:\\*\\*\\s*(.+)`, "i");
  const match = content.match(regex);
  if (!match) return null;
  const value = match[1]!.trim();
  // Skip placeholder values
  if (value.startsWith("_") || value.startsWith("(")) return null;
  return value || null;
}

/** Debounce timer for IDENTITY.md changes. */
let identityDebounce: ReturnType<typeof setTimeout> | null = null;

/** Read IDENTITY.md and send persona_update to backend. */
async function syncIdentity(): Promise<void> {
  try {
    const content = await Bun.file(IDENTITY_PATH).text();
    const name = extractField(content, "Nom");
    const emoji = extractField(content, "Emoji");

    // Only send if at least one field is populated
    if (name || emoji) {
      sendMessage({ type: "persona_update", name, emoji } as any);
      console.log(`[persona] Identity synced: name=${name}, emoji=${emoji}`);
    }
  } catch {
    // File doesn't exist or is unreadable — skip
  }
}

/** Track if BOOTSTRAP.md existed on last check. */
let bootstrapExisted = false;

/** Check if BOOTSTRAP.md was deleted (onboarding completed). */
function checkBootstrapDeletion(): void {
  const exists = existsSync(BOOTSTRAP_PATH);
  if (bootstrapExisted && !exists) {
    console.log("[persona] BOOTSTRAP.md deleted — onboarding completed");
    sendMessage({ type: "onboarding_completed" } as any);
  }
  bootstrapExisted = exists;
}

/**
 * Start watching the .agent/ directory for persona file changes.
 * Safe to call even if .agent/ doesn't exist yet — will retry periodically.
 */
export function startPersonaWatcher(): void {
  if (!existsSync(AGENT_DIR)) {
    // .agent/ doesn't exist — persona not enabled, check again in 60s
    setTimeout(startPersonaWatcher, 60_000);
    return;
  }

  // Initial state
  bootstrapExisted = existsSync(BOOTSTRAP_PATH);

  // Initial sync of identity
  syncIdentity();

  try {
    watch(AGENT_DIR, { recursive: false }, (eventType, filename) => {
      if (!filename) return;

      if (filename === "IDENTITY.md") {
        // Debounce — Claude may write multiple times rapidly
        if (identityDebounce) clearTimeout(identityDebounce);
        identityDebounce = setTimeout(syncIdentity, 2_000);
      }

      if (filename === "BOOTSTRAP.md") {
        // Small delay to let the deletion settle
        setTimeout(checkBootstrapDeletion, 500);
      }
    });

    console.log("[persona] Watching .agent/ for changes");
  } catch (err) {
    console.warn("[persona] Failed to start watcher:", err);
  }
}
