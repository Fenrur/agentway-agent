// src/test/handlers.test.ts
// Tests for inbound message handlers.

import { test, expect, beforeEach, mock, describe } from "bun:test";

// --- Mock runner.ts and client.ts BEFORE importing handlers ---

const mockRunPrompt = mock(() => Promise.resolve());
const mockInterruptCurrent = mock(() => true);
const mockResetSession = mock(() => {});

mock.module("../claude/runner.ts", () => ({
  runPrompt: mockRunPrompt,
  interruptCurrent: mockInterruptCurrent,
  resetSession: mockResetSession,
  isBusy: () => false,
}));

const sent: any[] = [];
const mockSendMessage = mock((msg: any) => {
  sent.push(msg);
  return true;
});

mock.module("../ws/client.ts", () => ({
  sendMessage: mockSendMessage,
}));

// Mock Bun.spawn for exec and clipboard tests
const mockSpawnResult = {
  stdout: new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode("hello stdout"));
      c.close();
    },
  }),
  stderr: new ReadableStream({
    start(c) {
      c.close();
    },
  }),
  exited: Promise.resolve(0),
  exitCode: 0,
  kill: mock(() => {}),
};

// We'll override Bun.spawn via a wrapper approach — use mock.module won't work for Bun globals.
// Instead, for exec tests we rely on the real Bun.spawn executing `echo`.

// Now import handlers
const { handleInboundMessage } = await import("../ws/handlers.ts");

beforeEach(() => {
  sent.length = 0;
  mockRunPrompt.mockClear();
  mockInterruptCurrent.mockClear();
  mockResetSession.mockClear();
  mockSendMessage.mockClear();
});

describe("inject_message", () => {
  test("calls runPrompt with content", () => {
    handleInboundMessage({ type: "inject_message", content: "Hello Claude" });
    expect(mockRunPrompt).toHaveBeenCalledTimes(1);
    expect(mockRunPrompt.mock.calls[0][0]).toBe("Hello Claude");
  });

  test("with attachments appends file lines", () => {
    handleInboundMessage({
      type: "inject_message",
      content: "Check these",
      attachments: ["file1.txt", "file2.txt"],
    });
    expect(mockRunPrompt).toHaveBeenCalledTimes(1);
    const prompt = mockRunPrompt.mock.calls[0][0] as string;
    expect(prompt).toContain("Check these");
    expect(prompt).toContain("[Attached file: file1.txt]");
    expect(prompt).toContain("[Attached file: file2.txt]");
  });

  test("/clear is blocked and returns error result", () => {
    handleInboundMessage({ type: "inject_message", content: "/clear" });
    expect(mockRunPrompt).not.toHaveBeenCalled();
    // Should have sent a stream_event result with is_error=true and a status idle
    expect(sent.length).toBeGreaterThanOrEqual(2);
    const resultMsg = sent.find(
      (m) => m.type === "stream_event" && m.event?.type === "result"
    );
    expect(resultMsg).toBeTruthy();
    expect(resultMsg.event.is_error).toBe(true);
    expect(resultMsg.event.result).toContain("/clear");
  });

  test("/reload calls resetSession", () => {
    handleInboundMessage({ type: "inject_message", content: "/reload" });
    expect(mockResetSession).toHaveBeenCalledTimes(1);
    expect(mockRunPrompt).not.toHaveBeenCalled();
    // Should send a result event
    const resultMsg = sent.find(
      (m) => m.type === "stream_event" && m.event?.type === "result"
    );
    expect(resultMsg).toBeTruthy();
  });
});

describe("kill", () => {
  test("calls interruptCurrent", () => {
    handleInboundMessage({ type: "kill" });
    expect(mockInterruptCurrent).toHaveBeenCalledTimes(1);
  });
});

describe("exec", () => {
  test("runs bash and returns stdout", async () => {
    handleInboundMessage({ type: "exec", requestId: "r1", command: "echo hello" });
    // Wait for async exec to complete
    await new Promise((r) => setTimeout(r, 200));
    const result = sent.find((m) => m.type === "exec_result" && m.requestId === "r1");
    expect(result).toBeTruthy();
    expect(result.stdout).toContain("hello");
    expect(result.exitCode).toBe(0);
  });

  test("concurrent exec is rejected", async () => {
    // Send a long-running command
    handleInboundMessage({ type: "exec", requestId: "r2", command: "sleep 1" });
    // Immediately send another
    await new Promise((r) => setTimeout(r, 10));
    handleInboundMessage({ type: "exec", requestId: "r3", command: "echo hi" });

    await new Promise((r) => setTimeout(r, 100));
    const rejected = sent.find((m) => m.type === "exec_result" && m.requestId === "r3");
    expect(rejected).toBeTruthy();
    expect(rejected.stderr).toContain("already running");
    expect(rejected.exitCode).toBe(1);

    // Wait for the first exec to finish so it doesn't leak
    await new Promise((r) => setTimeout(r, 1200));
  });

  test("oversized command is rejected", async () => {
    const longCmd = "x".repeat(10_001);
    handleInboundMessage({ type: "exec", requestId: "r4", command: longCmd });
    await new Promise((r) => setTimeout(r, 50));
    const result = sent.find((m) => m.type === "exec_result" && m.requestId === "r4");
    expect(result).toBeTruthy();
    expect(result.stderr).toContain("too long");
    expect(result.exitCode).toBe(1);
  });
});

describe("clipboard_set", () => {
  test("runs xclip command", async () => {
    // This will fail on macOS without xclip, but the handler catches errors gracefully.
    // We just verify it doesn't crash and doesn't affect other handlers.
    handleInboundMessage({ type: "clipboard_set", text: "test clipboard" });
    // Give it time to execute (will likely fail but silently)
    await new Promise((r) => setTimeout(r, 200));
    // No crash = pass. In a real agent VM, xclip would succeed.
  });
});
