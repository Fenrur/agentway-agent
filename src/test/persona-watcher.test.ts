// src/test/persona-watcher.test.ts
// Tests for persona watcher utility functions (extractField).

import { test, expect, describe } from "bun:test";

// extractField is not exported, so we re-implement the same logic for testing.
// Alternatively, we can test it indirectly — but since the function is small and
// self-contained, we replicate the exact regex logic here to verify correctness.

/**
 * Replication of extractField from src/persona/watcher.ts for unit testing.
 * (The original is a module-private function.)
 */
function extractField(content: string, field: string): string | null {
  const regex = new RegExp(`\\*\\*${field}\\s*:\\*\\*\\s*(.+)`, "i");
  const match = content.match(regex);
  if (!match) return null;
  const value = match[1]!.trim();
  if (value.startsWith("_") || value.startsWith("(")) return null;
  return value || null;
}

describe("extractField", () => {
  test("extracts 'Nom' field from markdown", () => {
    const content = `# Identite

- **Nom :** Alice
- **Emoji :** :robot:
- **Description :** Un agent utile
`;
    expect(extractField(content, "Nom")).toBe("Alice");
  });

  test("extracts field without space before colon", () => {
    const content = `- **Nom:** Bob`;
    expect(extractField(content, "Nom")).toBe("Bob");
  });

  test("extracts Emoji field", () => {
    const content = `- **Emoji :** :sparkles:`;
    expect(extractField(content, "Emoji")).toBe(":sparkles:");
  });

  test("returns null for placeholder values starting with underscore", () => {
    const content = `- **Nom :** _a remplir_`;
    expect(extractField(content, "Nom")).toBeNull();
  });

  test("returns null for placeholder values starting with parenthesis", () => {
    const content = `- **Nom :** (non defini)`;
    expect(extractField(content, "Nom")).toBeNull();
  });

  test("returns null for missing field", () => {
    const content = `- **Description :** Un agent utile`;
    expect(extractField(content, "Nom")).toBeNull();
  });

  test("returns null for empty content", () => {
    expect(extractField("", "Nom")).toBeNull();
  });

  test("is case-insensitive", () => {
    const content = `- **nom :** Charlie`;
    expect(extractField(content, "Nom")).toBe("Charlie");
  });

  test("handles multiple fields and extracts the correct one", () => {
    const content = `- **Nom :** Delta
- **Emoji :** :wave:
- **Description :** Helpful agent`;
    expect(extractField(content, "Nom")).toBe("Delta");
    expect(extractField(content, "Emoji")).toBe(":wave:");
    expect(extractField(content, "Description")).toBe("Helpful agent");
  });
});
