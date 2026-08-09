import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

/**
 * A host is addressed either directly (`endpoint`) or through the relay (`offer`). The offer is
 * the pairing URL Paseo already renders as a QR code; it carries the daemon's public key in its
 * fragment, which is what makes the relay path end-to-end encrypted. Prefer offers for machines
 * that are not reachable from wherever the connector runs.
 */
export const ConnectorHostConfigSchema = z
  .object({
    name: z.string().trim().min(1),
    endpoint: z.string().trim().min(1).optional(),
    offer: z.string().trim().min(1).optional(),
    password: z.string().optional(),
    description: z.string().optional(),
  })
  .refine((host) => Boolean(host.endpoint) !== Boolean(host.offer), {
    message: "Each host needs exactly one of endpoint or offer",
  });

export type ConnectorHostConfig = z.infer<typeof ConnectorHostConfigSchema>;

export const ConnectorConfigSchema = z.object({
  version: z.literal(1).optional(),
  listen: z.string().trim().min(1).optional(),
  publicUrl: z.string().trim().url().optional(),
  pairingCode: z.string().trim().min(1).optional(),
  hosts: z.array(ConnectorHostConfigSchema).default([]),
});

export type ConnectorConfigInput = z.infer<typeof ConnectorConfigSchema>;

export interface ConnectorConfig {
  listen: { host: string; port: number };
  /**
   * Canonical public origin. It is the OAuth resource identifier and the base of every discovery
   * document, so it has to match what Claude was given exactly — a mismatch fails audience
   * validation rather than degrading.
   */
  publicUrl: string;
  pairingCode: string;
  hosts: ConnectorHostConfig[];
  configPath: string;
}

const DEFAULT_LISTEN = "127.0.0.1:6790";

export function resolveConnectorConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.PASEO_CONNECTOR_CONFIG?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  const paseoHome = env.PASEO_HOME?.trim();
  return path.join(
    paseoHome ? path.resolve(paseoHome) : path.join(homedir(), ".paseo"),
    "connector.json",
  );
}

export function parseListen(value: string): { host: string; port: number } {
  const trimmed = value.trim();
  const match = trimmed.startsWith("[")
    ? trimmed.match(/^\[([^\]]+)\]:(\d{1,5})$/)
    : trimmed.match(/^(.+):(\d{1,5})$/);
  if (!match) {
    throw new Error(`Invalid listen address: ${value} (expected host:port)`);
  }
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid listen port in: ${value}`);
  }
  return { host: match[1], port };
}

/** Trailing slashes make the OAuth resource identifier ambiguous; RFC 8707 wants one canonical form. */
export function normalizePublicUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error(`publicUrl must be https (got ${url.protocol}//)`);
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

/**
 * The pairing code is the whole boundary between the public internet and full daemon authority,
 * and it is typed into a page anyone can reach. Approval attempts are rate limited, but a code a
 * human invented is still the weakest link, so refuse the ones that are guessable at all.
 *
 * 24 characters is the floor because that is roughly where even an all-lowercase passphrase clears
 * 100 bits, and it is short enough to paste from `openssl rand -base64 24`.
 */
export const MIN_PAIRING_CODE_LENGTH = 24;

export function assertStrongPairingCode(code: string): void {
  const suggestion = "Generate one with: openssl rand -base64 24";
  if (code.length < MIN_PAIRING_CODE_LENGTH) {
    throw new Error(
      `pairingCode must be at least ${MIN_PAIRING_CODE_LENGTH} characters (got ${code.length}). It is the only secret protecting every host this connector reaches. ${suggestion}`,
    );
  }
  if (new Set(code).size < 8) {
    throw new Error(
      `pairingCode repeats too few distinct characters to be unguessable. ${suggestion}`,
    );
  }
}

export function resolveConnectorConfig(options?: {
  env?: NodeJS.ProcessEnv;
  readFile?: (filePath: string) => string;
}): ConnectorConfig {
  const env = options?.env ?? process.env;
  const readFile = options?.readFile ?? ((filePath: string) => readFileSync(filePath, "utf-8"));
  const configPath = resolveConnectorConfigPath(env);

  let raw: unknown = {};
  try {
    raw = JSON.parse(readFile(configPath)) as unknown;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw new Error(`Failed to read connector config at ${configPath}: ${String(error)}`, {
        cause: error,
      });
    }
  }

  const parsed = ConnectorConfigSchema.parse(raw);

  const listen = parseListen(env.PASEO_CONNECTOR_LISTEN?.trim() || parsed.listen || DEFAULT_LISTEN);
  const publicUrlRaw = env.PASEO_CONNECTOR_PUBLIC_URL?.trim() || parsed.publicUrl;
  if (!publicUrlRaw) {
    throw new Error(
      `No publicUrl configured. Set publicUrl in ${configPath} or PASEO_CONNECTOR_PUBLIC_URL to the HTTPS origin Claude will reach this connector on.`,
    );
  }
  const pairingCode = env.PASEO_CONNECTOR_PAIRING_CODE?.trim() || parsed.pairingCode;
  if (!pairingCode) {
    throw new Error(
      `No pairingCode configured. Set pairingCode in ${configPath} or PASEO_CONNECTOR_PAIRING_CODE; it is the only thing standing between the public internet and your agents.`,
    );
  }
  assertStrongPairingCode(pairingCode);

  const names = new Set<string>();
  for (const host of parsed.hosts) {
    const key = host.name.toLowerCase();
    if (names.has(key)) {
      throw new Error(`Duplicate host name in connector config: ${host.name}`);
    }
    names.add(key);
  }

  return {
    listen,
    publicUrl: normalizePublicUrl(publicUrlRaw),
    pairingCode,
    hosts: parsed.hosts,
    configPath,
  };
}
