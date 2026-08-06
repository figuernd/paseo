import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_ENROLLMENT_TTL_MS,
  fingerprintPublicKey,
  PairedClientStore,
} from "./paired-clients.js";

const roots: string[] = [];

async function makeHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "paseo-paired-clients-"));
  roots.push(home);
  return home;
}

const CLIENT_A = "Y2xpZW50LWEtcHVibGljLWtleS0zMi1ieXRlcy1wYWQ=";
const CLIENT_B = "Y2xpZW50LWItcHVibGljLWtleS0zMi1ieXRlcy1wYWQ=";

describe("paired client store", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("rejects an unknown client that presents no enrollment token", async () => {
    const store = new PairedClientStore(await makeHome());

    expect(store.authorize({ publicKeyB64: CLIENT_A })).toEqual({
      outcome: "rejected",
      reason: "unknown-client",
    });
    expect(store.list()).toEqual([]);
  });

  test("rejects an enrollment token the daemon never minted", async () => {
    const store = new PairedClientStore(await makeHome());

    expect(store.authorize({ publicKeyB64: CLIENT_A, enrollToken: "made-up" })).toEqual({
      outcome: "rejected",
      reason: "invalid-enrollment",
    });
  });

  test("enrolls a client that redeems a valid token, then knows it without one", async () => {
    const store = new PairedClientStore(await makeHome());
    const token = store.createEnrollment();

    const first = store.authorize({ publicKeyB64: CLIENT_A, enrollToken: token });
    expect(first.outcome).toBe("enrolled");

    // Reconnects carry the same (already consumed) token; the key is what counts now.
    expect(store.authorize({ publicKeyB64: CLIENT_A }).outcome).toBe("known");
    expect(store.list()).toHaveLength(1);
  });

  test("consumes the token so a leaked link admits only the first device", async () => {
    const store = new PairedClientStore(await makeHome());
    const token = store.createEnrollment();

    expect(store.authorize({ publicKeyB64: CLIENT_A, enrollToken: token }).outcome).toBe(
      "enrolled",
    );
    // This is the whole point: the same link cannot enroll a second device.
    expect(store.authorize({ publicKeyB64: CLIENT_B, enrollToken: token })).toEqual({
      outcome: "rejected",
      reason: "invalid-enrollment",
    });
    expect(store.list()).toHaveLength(1);
  });

  test("expires a token that is never redeemed", async () => {
    const store = new PairedClientStore(await makeHome());
    const nowMs = 1_000_000;
    const token = store.createEnrollment({ nowMs });

    const afterExpiry = nowMs + DEFAULT_ENROLLMENT_TTL_MS + 1;
    expect(
      store.authorize({ publicKeyB64: CLIENT_A, enrollToken: token, nowMs: afterExpiry }),
    ).toEqual({ outcome: "rejected", reason: "invalid-enrollment" });
  });

  test("revoking a client makes its key unknown again", async () => {
    const store = new PairedClientStore(await makeHome());
    store.authorize({ publicKeyB64: CLIENT_A, enrollToken: store.createEnrollment() });

    const removed = store.revoke(fingerprintPublicKey(CLIENT_A));

    expect(removed?.publicKeyB64).toBe(CLIENT_A);
    expect(store.list()).toEqual([]);
    expect(store.authorize({ publicKeyB64: CLIENT_A })).toEqual({
      outcome: "rejected",
      reason: "unknown-client",
    });
  });

  test("revoking an unknown fingerprint reports nothing removed", async () => {
    const store = new PairedClientStore(await makeHome());

    expect(store.revoke("nope")).toBeNull();
  });

  test("revokeAll clears clients and outstanding offers", async () => {
    const store = new PairedClientStore(await makeHome());
    const unusedToken = store.createEnrollment();
    store.authorize({ publicKeyB64: CLIENT_A, enrollToken: store.createEnrollment() });

    expect(store.revokeAll()).toHaveLength(1);

    expect(store.list()).toEqual([]);
    // A pairing link minted before rotation must not survive it.
    expect(store.authorize({ publicKeyB64: CLIENT_B, enrollToken: unusedToken })).toEqual({
      outcome: "rejected",
      reason: "invalid-enrollment",
    });
  });

  test("survives a daemon restart", async () => {
    const home = await makeHome();
    const first = new PairedClientStore(home);
    first.authorize({ publicKeyB64: CLIENT_A, enrollToken: first.createEnrollment() });

    const reopened = new PairedClientStore(home);

    expect(reopened.list().map((c) => c.publicKeyB64)).toEqual([CLIENT_A]);
    expect(reopened.authorize({ publicKeyB64: CLIENT_A }).outcome).toBe("known");
  });

  test("keeps an offer redeemable across a restart", async () => {
    const home = await makeHome();
    const token = new PairedClientStore(home).createEnrollment();

    // The daemon can restart between rendering the QR and the phone scanning it.
    expect(
      new PairedClientStore(home).authorize({ publicKeyB64: CLIENT_A, enrollToken: token }).outcome,
    ).toBe("enrolled");
  });

  test("sees an offer minted by another process", async () => {
    // `paseo daemon pair` mints from the CLI process while the handshake is
    // authorized inside the daemon. A store that only read at construction
    // would never see the token and pairing would silently never work.
    const home = await makeHome();
    const daemonSide = new PairedClientStore(home);
    daemonSide.list();

    const cliSide = new PairedClientStore(home);
    const token = cliSide.createEnrollment();

    expect(daemonSide.authorize({ publicKeyB64: CLIENT_A, enrollToken: token }).outcome).toBe(
      "enrolled",
    );
  });

  test("sees a revocation performed by another process", async () => {
    const home = await makeHome();
    const daemonSide = new PairedClientStore(home);
    daemonSide.authorize({ publicKeyB64: CLIENT_A, enrollToken: daemonSide.createEnrollment() });

    new PairedClientStore(home).revoke(fingerprintPublicKey(CLIENT_A));

    expect(daemonSide.authorize({ publicKeyB64: CLIENT_A })).toEqual({
      outcome: "rejected",
      reason: "unknown-client",
    });
  });

  test("stores the file with owner-only permissions", async () => {
    const home = await makeHome();
    const store = new PairedClientStore(home);
    store.createEnrollment();

    const stats = await stat(path.join(home, "paired-clients.json"));

    expect(stats.mode & 0o777).toBe(0o600);
  });

  test("starts empty rather than locking the operator out of a corrupt file", async () => {
    const home = await makeHome();
    const store = new PairedClientStore(home);
    store.authorize({ publicKeyB64: CLIENT_A, enrollToken: store.createEnrollment() });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(home, "paired-clients.json"), "{ not json");

    const reopened = new PairedClientStore(home);

    expect(reopened.list()).toEqual([]);
    // Re-pairing still works; the operator is not stuck.
    expect(
      reopened.authorize({ publicKeyB64: CLIENT_A, enrollToken: reopened.createEnrollment() })
        .outcome,
    ).toBe("enrolled");
  });
});
