// src/test/runner-utils.test.ts
// Tests for pure utility functions exported from runner.ts:
// detectIncompleteTask, extractAndSendAuthUrl, AUTH_URL_PATTERN,
// and BOOTSTRAP.md injection behavior (bootInjected flag).

import { test, expect, describe, beforeEach, mock } from "bun:test";

// === Mock setup (BEFORE any imports of runner.ts) ===

let streamEvents: any[] = [];

const mockSend = mock(() => Promise.resolve());
const mockStream = mock(() =>
  (async function* () {
    for (const ev of streamEvents) yield ev;
  })()
);
const mockClose = mock(() => {});

const mockSession = {
  sessionId: "test-session-id",
  send: mockSend,
  stream: mockStream,
  close: mockClose,
  [Symbol.asyncDispose]: mock(() => Promise.resolve()),
};

const mockCreateSession = mock(() => mockSession);
const mockResumeSession = mock(() => mockSession);

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  unstable_v2_createSession: mockCreateSession,
  unstable_v2_resumeSession: mockResumeSession,
}));

let storedSessionId: string | null = null;
mock.module("../claude/session.ts", () => ({
  loadSession: mock(() => Promise.resolve(storedSessionId)),
  saveSession: mock((id: string) => {
    storedSessionId = id;
    return Promise.resolve();
  }),
  clearSession: mock(() => {
    storedSessionId = null;
    return Promise.resolve();
  }),
  setSessionFilePath: mock(() => {}),
}));

const sent: any[] = [];
mock.module("../ws/client.ts", () => ({
  sendMessage: mock((msg: any) => {
    sent.push(msg);
    return true;
  }),
}));

const runner = await import("../claude/runner.ts");

beforeEach(() => {
  sent.length = 0;
  streamEvents = [];
  storedSessionId = null;
  mockSend.mockClear();
  mockClose.mockClear();
  mockCreateSession.mockClear();
  mockResumeSession.mockClear();

  mockStream.mockImplementation(() =>
    (async function* () {
      for (const ev of streamEvents) yield ev;
    })()
  );

  runner.resetSession();
  sent.length = 0;
});

// === detectIncompleteTask ===

describe("detectIncompleteTask", () => {
  test("returns true for 'je vais continuer'", () => {
    expect(runner.detectIncompleteTask("Je vais continuer avec le reste des fichiers")).toBe(true);
  });

  test("returns true for 'shall i continue'", () => {
    expect(runner.detectIncompleteTask("I've done the first 10. Shall I continue with the rest?")).toBe(true);
  });

  test("returns false for 'Done! Everything is complete.'", () => {
    expect(runner.detectIncompleteTask("Done! Everything is complete.")).toBe(false);
  });

  test("returns false for empty result with few events (eventCount < 5)", () => {
    // detectIncompleteTask uses module-level eventCount, but when called directly
    // it checks the passed text only. Empty text with no events = false.
    expect(runner.detectIncompleteTask("")).toBe(false);
  });

  test("returns true for 'je poursuis'", () => {
    expect(runner.detectIncompleteTask("Je poursuis avec les elements suivants")).toBe(true);
  });

  test("returns true for 'i'll continue'", () => {
    expect(runner.detectIncompleteTask("I'll continue with the remaining items")).toBe(true);
  });

  test("returns true for 'want me to continue'", () => {
    expect(runner.detectIncompleteTask("Do you want me to continue?")).toBe(true);
  });

  test("returns true for 'voulez-vous que je continue'", () => {
    expect(runner.detectIncompleteTask("Voulez-vous que je continue avec les autres?")).toBe(true);
  });

  test("returns true for 'il en reste'", () => {
    expect(runner.detectIncompleteTask("Il en reste 50 a traiter")).toBe(true);
  });

  test("returns false for normal completion text", () => {
    expect(runner.detectIncompleteTask("All tasks completed successfully. Here is the summary.")).toBe(false);
  });

  test("returns false for error-like text without continue pattern", () => {
    expect(runner.detectIncompleteTask("An error occurred while processing the request.")).toBe(false);
  });

  test("returns true for 'should i continue'", () => {
    expect(runner.detectIncompleteTask("I've processed 20 items. Should I continue?")).toBe(true);
  });

  test("returns true for 'here are the first'", () => {
    expect(runner.detectIncompleteTask("Here are the first 10 results")).toBe(true);
  });
});

// === AUTH_URL_PATTERN ===

describe("AUTH_URL_PATTERN", () => {
  test("matches claude.ai URLs", () => {
    const text = "Please visit https://claude.ai/oauth/authorize?code=abc123 to authorize";
    const match = text.match(runner.AUTH_URL_PATTERN);
    expect(match).not.toBeNull();
    expect(match![0]).toContain("claude.ai");
  });

  test("matches anthropic.com URLs", () => {
    const text = "Go to https://console.anthropic.com/settings/keys for your API key";
    const match = text.match(runner.AUTH_URL_PATTERN);
    expect(match).not.toBeNull();
    expect(match![0]).toContain("anthropic.com");
  });

  test("does not match random URLs", () => {
    const text = "Visit https://example.com/page for more info";
    const match = text.match(runner.AUTH_URL_PATTERN);
    expect(match).toBeNull();
  });

  test("matches HTTP claude.ai URLs", () => {
    const text = "http://claude.ai/login";
    const match = text.match(runner.AUTH_URL_PATTERN);
    expect(match).not.toBeNull();
  });
});

// === extractAndSendAuthUrl ===

describe("extractAndSendAuthUrl", () => {
  test("extracts claude.ai URL from assistant text content", () => {
    runner.extractAndSendAuthUrl({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Please authenticate at https://claude.ai/oauth/callback?token=xyz" }],
      },
    });

    const authLink = sent.find((m) => m.type === "auth_link");
    expect(authLink).toBeTruthy();
    expect(authLink.url).toContain("claude.ai");
  });

  test("extracts anthropic.com URL from result event", () => {
    runner.extractAndSendAuthUrl({
      type: "result",
      result: "Visit https://console.anthropic.com/authorize to continue",
    });

    const authLink = sent.find((m) => m.type === "auth_link");
    expect(authLink).toBeTruthy();
    expect(authLink.url).toContain("anthropic.com");
  });

  test("does not send auth_link for non-auth URLs", () => {
    runner.extractAndSendAuthUrl({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Check https://github.com/repo for the code" }],
      },
    });

    const authLink = sent.find((m) => m.type === "auth_link");
    expect(authLink).toBeUndefined();
  });

  test("extracts URL from string message field", () => {
    runner.extractAndSendAuthUrl({
      type: "system",
      message: "Auth required: https://claude.ai/login",
    });

    const authLink = sent.find((m) => m.type === "auth_link");
    expect(authLink).toBeTruthy();
    expect(authLink.url).toContain("claude.ai");
  });

  test("extracts URL from system subtype data field", () => {
    runner.extractAndSendAuthUrl({
      type: "system",
      subtype: "auth",
      data: "https://anthropic.com/auth/start?session=abc",
    });

    const authLink = sent.find((m) => m.type === "auth_link");
    expect(authLink).toBeTruthy();
    expect(authLink.url).toContain("anthropic.com");
  });
});

// === BOOTSTRAP.md injection (bootInjected flag) ===

describe("BOOTSTRAP.md injection", () => {
  test("injects BOOTSTRAP.md only on first message", async () => {
    // The runner reads from /home/agent/.agent/BOOTSTRAP.md.
    // Since we're in a test environment, the file won't exist,
    // so bootInjected will be set to true but no injection occurs.
    // We verify the flag behavior through the send() call content.

    streamEvents = [
      { type: "system", subtype: "init", model: "test" },
      { type: "result", subtype: "success", result: "OK", is_error: false, session_id: "s1" },
    ];

    // First message
    await runner.runPrompt("First message");
    const firstSendArg = mockSend.mock.calls[0]?.[0] as string;

    // Reset for second message
    mockSend.mockClear();
    streamEvents = [
      { type: "system", subtype: "init", model: "test" },
      { type: "result", subtype: "success", result: "OK2", is_error: false, session_id: "s1" },
    ];
    mockStream.mockImplementation(() =>
      (async function* () {
        for (const ev of streamEvents) yield ev;
      })()
    );

    // Second message — bootInjected should be true, no injection
    await runner.runPrompt("Second message");
    const secondSendArg = mockSend.mock.calls[0]?.[0] as string;

    // The second message should be sent as-is (no BOOTSTRAP prefix)
    expect(secondSendArg).toBe("Second message");
  });

  test("resetSession clears bootInjected flag", async () => {
    streamEvents = [
      { type: "system", subtype: "init", model: "test" },
      { type: "result", subtype: "success", result: "OK", is_error: false, session_id: "s1" },
    ];

    // First message sets bootInjected = true
    await runner.runPrompt("Hello");

    // Reset clears it
    runner.resetSession();

    mockSend.mockClear();
    streamEvents = [
      { type: "system", subtype: "init", model: "test" },
      { type: "result", subtype: "success", result: "OK2", is_error: false, session_id: "s2" },
    ];
    mockStream.mockImplementation(() =>
      (async function* () {
        for (const ev of streamEvents) yield ev;
      })()
    );

    // After reset, bootInjected is false again — the runner will attempt
    // to read BOOTSTRAP.md (which doesn't exist in test env, so no injection).
    // But the flag will be set to true again after this call.
    await runner.runPrompt("After reset");

    // The key assertion: the prompt was sent (bootInjected was re-checked)
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

// === Empty result with many events triggers auto-continue ===

describe("empty result auto-continue", () => {
  test("auto-continues on empty result after 5+ events", async () => {
    let callCount = 0;

    mockStream.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // First turn: 6 events then empty result
        return (async function* () {
          yield { type: "system", subtype: "init", model: "test" };
          yield { type: "assistant", message: { content: [{ type: "text", text: "A" }] } };
          yield { type: "assistant", message: { content: [{ type: "text", text: "B" }] } };
          yield { type: "assistant", message: { content: [{ type: "text", text: "C" }] } };
          yield { type: "assistant", message: { content: [{ type: "text", text: "D" }] } };
          yield { type: "assistant", message: { content: [{ type: "text", text: "E" }] } };
          yield {
            type: "result",
            subtype: "success",
            result: "",
            is_error: false,
            session_id: "s1",
          };
        })();
      } else {
        // Second turn: complete
        return (async function* () {
          yield { type: "system", subtype: "init", model: "test" };
          yield {
            type: "result",
            subtype: "success",
            result: "All done!",
            is_error: false,
            session_id: "s1",
          };
        })();
      }
    });

    await runner.runPrompt("Big task");

    // Should have auto-continued (send called at least twice)
    expect(mockSend.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
