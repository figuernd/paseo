import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { importSecretKey } from "@getpaseo/relay/e2ee";
import { getOrCreateClientSecretKey } from "./client-identity.js";

let dir: string;
let keyPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "connector-identity-"));
  keyPath = path.join(dir, "connector-client-key");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("getOrCreateClientSecretKey", () => {
  /**
   * The whole point. A daemon enrolls this key once and refuses anything else, so a connector
   * that minted a new one per process would pair on first run and be locked out on restart.
   */
  test("returns the same key across separate calls, as a restart would", () => {
    const first = getOrCreateClientSecretKey(keyPath);
    const second = getOrCreateClientSecretKey(keyPath);

    expect(second).toBe(first);
    expect(readFileSync(keyPath, "utf8").trim()).toBe(first);
  });

  test("mints a key the relay can actually import", () => {
    const secretKeyB64 = getOrCreateClientSecretKey(keyPath);

    expect(() => importSecretKey(secretKeyB64)).not.toThrow();
  });

  test("two connectors with separate state directories get separate identities", () => {
    const other = path.join(mkdtempSync(path.join(tmpdir(), "connector-identity-")), "key");

    expect(getOrCreateClientSecretKey(keyPath)).not.toBe(getOrCreateClientSecretKey(other));
  });

  test("writes the key owner-only", () => {
    getOrCreateClientSecretKey(keyPath);

    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  test("tightens a key file that was left group- or world-readable", () => {
    const existing = getOrCreateClientSecretKey(keyPath);
    chmodSync(keyPath, 0o644);

    expect(getOrCreateClientSecretKey(keyPath)).toBe(existing);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  test("creates the state directory when it does not exist yet", () => {
    const nested = path.join(dir, "does", "not", "exist", "connector-client-key");

    expect(getOrCreateClientSecretKey(nested)).toBeTypeOf("string");
    expect(readFileSync(nested, "utf8").trim().length).toBeGreaterThan(0);
  });

  test("replaces an empty key file rather than handing back nothing", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(keyPath, "   \n", { mode: 0o600 });

    const secretKeyB64 = getOrCreateClientSecretKey(keyPath);

    expect(secretKeyB64.trim().length).toBeGreaterThan(0);
    expect(() => importSecretKey(secretKeyB64)).not.toThrow();
  });
});
