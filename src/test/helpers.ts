// src/test/helpers.ts
// Shared test helpers: mock SDK factory, message recorder.

/**
 * Create a mock SDK session that yields pre-configured events.
 */
export function createMockSession(streamEvents: Array<Record<string, unknown>> = []) {
  const session = {
    sessionId: "test-session-id",
    send: (() => Promise.resolve()) as ReturnType<typeof import("bun:test").mock>,
    stream: (() =>
      (async function* () {
        for (const ev of streamEvents) yield ev;
      })()) as ReturnType<typeof import("bun:test").mock>,
    close: (() => {}) as ReturnType<typeof import("bun:test").mock>,
    [Symbol.asyncDispose]: (() => Promise.resolve()) as ReturnType<typeof import("bun:test").mock>,
  };
  return session;
}

/**
 * Collect messages sent via a mocked sendMessage function.
 */
export function createMessageRecorder() {
  const sent: Array<Record<string, unknown>> = [];
  const sendMessage = (msg: Record<string, unknown>) => {
    sent.push(msg);
    return true;
  };
  return { sent, sendMessage };
}

/**
 * Build a typical SDK success stream sequence.
 */
export function successStream(text: string, sessionId = "s1") {
  return [
    { type: "system", subtype: "init", model: "claude-opus-4-6[1m]" },
    {
      type: "assistant",
      message: { content: [{ type: "text", text }] },
    },
    {
      type: "result",
      subtype: "success",
      result: text,
      is_error: false,
      session_id: sessionId,
    },
  ];
}

/**
 * Wait for a condition to be true, checking every `interval` ms up to `timeout` ms.
 */
export async function waitFor(
  predicate: () => boolean,
  timeout = 2000,
  interval = 10,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor timed out after ${timeout}ms`);
}
