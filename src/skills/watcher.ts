// src/skills/watcher.ts
// Watches ~/.claude/commands/ and ~/.claude/skills/ for changes.
// Sends the list of available skills/commands to the backend via WebSocket.

import { watch } from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { sendMessage } from "../ws/client.ts";

const HOME = process.env.HOME ?? "/home/agent";
const COMMANDS_DIR = join(HOME, ".claude", "commands");
const SKILLS_DIR = join(HOME, ".claude", "skills");

export interface SkillDef {
  name: string;
  description: string;
  source: "command" | "skill";
}

/**
 * Scan commands and skills directories, return list of available slash commands.
 */
async function scanSkills(): Promise<SkillDef[]> {
  const skills: SkillDef[] = [];

  // Scan .claude/commands/*.md
  try {
    const files = await readdir(COMMANDS_DIR);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const name = "/" + file.replace(/\.md$/, "");
      const content = await readFile(join(COMMANDS_DIR, file), "utf-8");
      const description = extractDescription(content);
      skills.push({ name, description, source: "command" });
    }
  } catch {
    // Directory might not exist
  }

  // Scan .claude/skills/*/SKILL.md
  try {
    const dirs = await readdir(SKILLS_DIR);
    for (const dir of dirs) {
      const skillPath = join(SKILLS_DIR, dir, "SKILL.md");
      try {
        const st = await stat(skillPath);
        if (!st.isFile()) continue;
        const content = await readFile(skillPath, "utf-8");
        const name = "/" + dir;
        const description = extractDescription(content);
        // Don't add if already exists from commands
        if (!skills.some((s) => s.name === name)) {
          skills.push({ name, description, source: "skill" });
        }
      } catch {
        // SKILL.md doesn't exist in this dir
      }
    }
  } catch {
    // Directory might not exist
  }

  return skills;
}

/**
 * Extract a description from the first non-empty, non-frontmatter line of a .md file.
 */
function extractDescription(content: string): string {
  const lines = content.split("\n");
  let inFrontmatter = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "---") {
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter) continue;
    if (!trimmed) continue;
    // Skip markdown headers
    if (trimmed.startsWith("#")) {
      return trimmed.replace(/^#+\s*/, "").slice(0, 80);
    }
    return trimmed.slice(0, 80);
  }

  return "";
}

/**
 * Send the current skills list to the backend.
 */
async function broadcastSkills(): Promise<void> {
  try {
    const skills = await scanSkills();
    sendMessage({ type: "skills_update", skills } as any);
    console.log(`[skills] Sent ${skills.length} skills to backend`);
  } catch (err) {
    console.error("[skills] Failed to scan/send skills:", err);
  }
}

/**
 * Start watching for skill/command changes.
 * Sends initial list + watches for file changes.
 */
export function startSkillsWatcher(): void {
  // Initial scan after 2s (let connection establish)
  setTimeout(() => broadcastSkills(), 2000);

  // Watch directories for changes
  for (const dir of [COMMANDS_DIR, SKILLS_DIR]) {
    try {
      watch(dir, { recursive: true }, () => {
        // Debounce: wait 500ms after last change
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => broadcastSkills(), 500);
      });
      console.log(`[skills] Watching ${dir}`);
    } catch {
      console.log(`[skills] ${dir} does not exist yet, will scan periodically`);
    }
  }

  // Periodic rescan every 60s (catch dirs created after startup)
  setInterval(() => broadcastSkills(), 60_000);
}

let debounceTimer: ReturnType<typeof setTimeout>;
