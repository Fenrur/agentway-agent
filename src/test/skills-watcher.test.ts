// src/test/skills-watcher.test.ts
// Tests for skills watcher utility functions (extractDescription).

import { test, expect, describe } from "bun:test";

/**
 * Replication of extractDescription from src/skills/watcher.ts for unit testing.
 * (The original is a module-private function.)
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
    if (trimmed.startsWith("#")) {
      return trimmed.replace(/^#+\s*/, "").slice(0, 80);
    }
    return trimmed.slice(0, 80);
  }

  return "";
}

describe("extractDescription", () => {
  test("extracts first non-frontmatter line", () => {
    const content = `This is the description of the skill.

Some more details here.`;
    expect(extractDescription(content)).toBe("This is the description of the skill.");
  });

  test("skips frontmatter (--- blocks)", () => {
    const content = `---
title: My Skill
version: 1.0
---
The actual description after frontmatter.`;
    expect(extractDescription(content)).toBe("The actual description after frontmatter.");
  });

  test("handles markdown headers", () => {
    const content = `# My Awesome Skill

This is the body text.`;
    expect(extractDescription(content)).toBe("My Awesome Skill");
  });

  test("handles h2 headers", () => {
    const content = `## Sub-heading Skill

Details`;
    expect(extractDescription(content)).toBe("Sub-heading Skill");
  });

  test("skips empty lines before content", () => {
    const content = `


The description after blank lines.`;
    expect(extractDescription(content)).toBe("The description after blank lines.");
  });

  test("returns empty string for empty content", () => {
    expect(extractDescription("")).toBe("");
  });

  test("returns empty string for content with only frontmatter", () => {
    const content = `---
title: Only frontmatter
---`;
    expect(extractDescription(content)).toBe("");
  });

  test("truncates to 80 characters", () => {
    const longLine = "A".repeat(120);
    expect(extractDescription(longLine)).toBe("A".repeat(80));
  });

  test("truncates header text to 80 characters", () => {
    const longHeader = "# " + "B".repeat(120);
    expect(extractDescription(longHeader)).toBe("B".repeat(80));
  });

  test("handles frontmatter then header", () => {
    const content = `---
key: value
---
# Skill Title

Body text.`;
    expect(extractDescription(content)).toBe("Skill Title");
  });

  test("skips frontmatter content lines", () => {
    const content = `---
This line is inside frontmatter
---
Outside frontmatter content`;
    expect(extractDescription(content)).toBe("Outside frontmatter content");
  });
});
