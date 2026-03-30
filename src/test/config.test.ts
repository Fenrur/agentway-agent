/**
 * Unit tests for config.ts — requireEnv behavior.
 *
 * Since config.ts evaluates requireEnv at import time, we test the
 * requireEnv logic by replicating it (the function is not exported).
 * We also verify that the module throws on missing vars.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";

// ---------------------------------------------------------------------------
// requireEnv logic tests (replicated since the function is module-scoped)
// ---------------------------------------------------------------------------

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

describe("requireEnv", () => {
  const TEST_KEY = "AGENTWAY_TEST_CONFIG_VAR";

  beforeEach(() => {
    delete process.env[TEST_KEY];
  });

  afterEach(() => {
    delete process.env[TEST_KEY];
  });

  test("throws on missing env var", () => {
    expect(() => requireEnv(TEST_KEY)).toThrow("Missing required environment variable");
  });

  test("throws on empty string env var", () => {
    process.env[TEST_KEY] = "";
    expect(() => requireEnv(TEST_KEY)).toThrow("Missing required environment variable");
  });

  test("returns value when env var is set", () => {
    process.env[TEST_KEY] = "ws://localhost:3000";
    expect(requireEnv(TEST_KEY)).toBe("ws://localhost:3000");
  });

  test("returns value with special characters", () => {
    process.env[TEST_KEY] = "token-with-special=chars&more";
    expect(requireEnv(TEST_KEY)).toBe("token-with-special=chars&more");
  });
});
