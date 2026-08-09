import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { exportSecretKey, generateKeyPair } from "@getpaseo/relay/e2ee";

/**
 * The connector's long-lived relay identity, as a base64 Curve25519 secret key.
 *
 * A daemon enrolls this key the first time the connector redeems a pairing offer and recognises
 * it on every connection after. The relay channel generates a fresh keypair when given none,
 * which would enroll once and then be refused, because the offer's token is already spent — and
 * the connector reconnects constantly, so it would fail almost immediately.
 *
 * One identity covers every host: enrollment is per daemon, and each daemon records this key
 * separately when it redeems its own offer.
 */
export function getOrCreateClientSecretKey(keyPath: string): string {
  try {
    const existing = readFileSync(keyPath, "utf8").trim();
    if (existing) {
      // A key that leaked through a permissive mode is still usable by whoever read it, but
      // tightening here stops the window staying open for every future run.
      if ((statSync(keyPath).mode & 0o077) !== 0) {
        chmodSync(keyPath, 0o600);
      }
      return existing;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Failed to read connector client key at ${keyPath}: ${String(error)}`, {
        cause: error,
      });
    }
  }

  const secretKeyB64 = exportSecretKey(generateKeyPair().secretKey);
  mkdirSync(path.dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, secretKeyB64, { mode: 0o600 });
  return secretKeyB64;
}
