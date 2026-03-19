// src/claude/session.ts
// Gestion de la session Claude Code — persistance du session ID.
// Permet de reprendre une session existante avec --resume <sessionId>.

import { join } from "path";

/** Chemin du fichier de session (relatif au cwd du daemon) */
const SESSION_FILE = join(process.cwd(), "session.json");

interface SessionData {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Charge le session ID depuis le fichier session.json.
 * Retourne null si le fichier n'existe pas ou est invalide.
 */
export async function loadSession(): Promise<string | null> {
  try {
    const file = Bun.file(SESSION_FILE);
    const exists = await file.exists();
    if (!exists) return null;

    const text = await file.text();
    const data: SessionData = JSON.parse(text);

    if (!data.sessionId || typeof data.sessionId !== "string") {
      console.warn("[session] Invalid session file — missing sessionId");
      return null;
    }

    console.log(`[session] Loaded session: ${data.sessionId.slice(0, 8)}...`);
    return data.sessionId;
  } catch (error) {
    console.warn("[session] Failed to load session file:", error);
    return null;
  }
}

/**
 * Sauvegarde le session ID dans session.json.
 * Cree ou ecrase le fichier existant.
 */
export async function saveSession(sessionId: string): Promise<void> {
  const data: SessionData = {
    sessionId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  try {
    // Verifier si un fichier existe deja pour conserver le createdAt
    const file = Bun.file(SESSION_FILE);
    const exists = await file.exists();
    if (exists) {
      try {
        const existing: SessionData = JSON.parse(await file.text());
        if (existing.createdAt) {
          data.createdAt = existing.createdAt;
        }
      } catch {
        // Fichier corrompu — on ecrase tout
      }
    }

    await Bun.write(SESSION_FILE, JSON.stringify(data, null, 2));
    console.log(`[session] Saved session: ${sessionId.slice(0, 8)}...`);
  } catch (error) {
    console.error("[session] Failed to save session file:", error);
  }
}

/**
 * Supprime le fichier de session.
 * Utile pour forcer une nouvelle session au prochain lancement.
 */
export async function clearSession(): Promise<void> {
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(SESSION_FILE);
    console.log("[session] Session file cleared");
  } catch {
    // Fichier n'existait pas — pas grave
  }
}
