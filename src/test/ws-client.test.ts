// src/test/ws-client.test.ts
// Tests for the WS client (connect, auth, send, disconnect) against a mock backend.

import { test, expect, beforeEach, afterEach, mock, describe } from "bun:test";

// --- Mock dependencies of ws/client.ts BEFORE importing it ---
// Paths must be resolvable from this file (test/) to the actual module locations.

mock.module("../claude/runner.ts", () => ({
  runPrompt: mock(() => Promise.resolve()),
  interruptCurrent: mock(() => false),
  resetSession: mock(() => {}),
  isBusy: () => false,
}));

mock.module("../ws/handlers.ts", () => ({
  handleInboundMessage: mock(() => {}),
}));

// Import after mocks
const { connect, disconnect, sendMessage, isConnected } = await import("../ws/client.ts");

// === Mock backend WebSocket server ===

let received: any[] = [];
let serverWs: any = null;
let mockBackend: ReturnType<typeof Bun.serve> | null = null;
let serverPort = 0;

function startMockBackend() {
  received = [];
  serverWs = null;

  mockBackend = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (new URL(req.url).pathname === "/ws/daemon") {
        server.upgrade(req, { data: {} });
        return;
      }
      return new Response("404", { status: 404 });
    },
    websocket: {
      message(ws, data) {
        const msg = JSON.parse(String(data));
        received.push(msg);

        // If it's an auth message, respond with auth_ok
        if (msg.type === "auth") {
          ws.send(JSON.stringify({ type: "auth_ok" }));
        }
      },
      open(ws) {
        serverWs = ws;
      },
      close() {
        serverWs = null;
      },
    },
  });

  serverPort = mockBackend.port;
}

function stopMockBackend() {
  if (mockBackend) {
    mockBackend.stop(true);
    mockBackend = null;
  }
}

function waitForCondition(predicate: () => boolean, timeout = 3000, interval = 20): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error("Timed out"));
      setTimeout(check, interval);
    };
    check();
  });
}

beforeEach(() => {
  startMockBackend();
  received = [];
});

afterEach(() => {
  disconnect();
  stopMockBackend();
});

describe("connection", () => {
  test("connects and sends auth message", async () => {
    connect(`ws://localhost:${serverPort}`, "test-token-123");

    await waitForCondition(() => received.length >= 1, 3000);

    expect(received[0]).toEqual({ type: "auth", token: "test-token-123" });
  });

  test("sends daemon_connected after auth_ok", async () => {
    connect(`ws://localhost:${serverPort}`, "test-token");

    // Wait for auth + daemon_connected + status
    await waitForCondition(() => received.length >= 3, 3000);

    const daemonConnected = received.find((m) => m.type === "daemon_connected");
    expect(daemonConnected).toBeTruthy();
  });
});

describe("sendMessage", () => {
  test("delivers when connected", async () => {
    connect(`ws://localhost:${serverPort}`, "test-token");

    await waitForCondition(() => isConnected(), 3000);

    const result = sendMessage({ type: "status", status: "working" });
    expect(result).toBe(true);

    await waitForCondition(
      () => received.some((m) => m.type === "status" && m.status === "working"),
      2000,
    );

    const statusMsg = received.find((m) => m.type === "status" && m.status === "working");
    expect(statusMsg).toBeTruthy();
  });

  test("returns false when disconnected", () => {
    // Not connected — sendMessage should return false
    disconnect(); // Ensure clean state
    const result = sendMessage({ type: "status", status: "idle" });
    expect(result).toBe(false);
  });
});

describe("state", () => {
  test("isConnected reflects state", async () => {
    expect(isConnected()).toBe(false);

    connect(`ws://localhost:${serverPort}`, "test-token");
    await waitForCondition(() => isConnected(), 3000);
    expect(isConnected()).toBe(true);

    disconnect();
    await waitForCondition(() => !isConnected(), 1000);
    expect(isConnected()).toBe(false);
  });

  test("disconnect stops reconnection", async () => {
    connect(`ws://localhost:${serverPort}`, "test-token");
    await waitForCondition(() => isConnected(), 3000);

    // Disconnect intentionally
    disconnect();
    await waitForCondition(() => !isConnected(), 1000);

    // Stop the mock backend so any reconnect attempt would fail
    stopMockBackend();

    // Wait a bit — if reconnection was scheduled, it would try to connect and fail
    await new Promise((r) => setTimeout(r, 1500));

    // Should still be disconnected, no crash
    expect(isConnected()).toBe(false);
  });
});
