import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { exportSecretKey, generateKeyPair } from "@getpaseo/relay/e2ee";

const CLIENT_KEY_FILE = join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "cli-client-key");

let cachedSecretKeyB64: string | null = null;

/**
 * The CLI's long-lived relay identity, as a base64 Curve25519 secret key.
 *
 * A daemon enrolls this key the first time the CLI redeems a pairing offer, and
 * recognises it on every connection after. Generating a fresh key per
 * connection — which is what the relay channel does when given none — would
 * enroll once and then be refused, because the token it used is already spent.
 *
 * Stored at mode 0600 next to cli-client-id.
 */
export async function getOrCreateCliClientSecretKey(): Promise<string> {
  if (cachedSecretKeyB64) {
    return cachedSecretKeyB64;
  }

  try {
    const existing = (await readFile(CLIENT_KEY_FILE, "utf8")).trim();
    if (existing) {
      cachedSecretKeyB64 = existing;
      return existing;
    }
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const secretKeyB64 = exportSecretKey(generateKeyPair().secretKey);
  await mkdir(dirname(CLIENT_KEY_FILE), { recursive: true });
  await writeFile(CLIENT_KEY_FILE, secretKeyB64, { mode: 0o600 });
  cachedSecretKeyB64 = secretKeyB64;
  return secretKeyB64;
}
