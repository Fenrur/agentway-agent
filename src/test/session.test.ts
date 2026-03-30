// src/test/session.test.ts
// Tests for session persistence (save/load/clear).

import { test, expect, beforeEach, afterEach } from "bun:test";
import { loadSession, saveSession, clearSession, setSessionFilePath } from "../claude/session.ts";

const tmpPath = `/tmp/agentway-test-session-${Date.now()}.json`;

beforeEach(() => {
  setSessionFilePath(tmpPath);
});

afterEach(async () => {
  // Clean up temp file
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(tmpPath);
  } catch {}
});

test("save + load roundtrip", async () => {
  await saveSession("abc-123-session");
  const loaded = await loadSession();
  expect(loaded).toBe("abc-123-session");
});

test("load returns null when file missing", async () => {
  // Point to a file that definitely does not exist
  setSessionFilePath(`/tmp/agentway-test-nonexistent-${Date.now()}.json`);
  const result = await loadSession();
  expect(result).toBeNull();
});

test("clear deletes file", async () => {
  await saveSession("to-be-cleared");
  await clearSession();
  const result = await loadSession();
  expect(result).toBeNull();
});

test("corrupt JSON returns null (no crash)", async () => {
  await Bun.write(tmpPath, "not valid json {{{");
  const result = await loadSession();
  expect(result).toBeNull();
});
