import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type pino from "pino";

import { ensurePrivateFile, writePrivateFileAtomicSync } from "./private-files.js";

const PAIRED_CLIENTS_FILENAME = "paired-clients.json";

/**
 * How long a pairing offer stays redeemable.
 *
 * Long enough to open the pairing panel and scan the QR with a phone, short
 * enough that a link pasted somewhere it shouldn't be goes stale on its own.
 */
export const DEFAULT_ENROLLMENT_TTL_MS = 10 * 60 * 1000;

const PairedClientSchema = z.object({
  publicKeyB64: z.string().min(1),
  fingerprint: z.string().min(1),
  label: z.string().nullable(),
  addedAt: z.string().min(1),
  lastSeenAt: z.string().nullable(),
});

const PendingEnrollmentSchema = z.object({
  token: z.string().min(1),
  expiresAtMs: z.number(),
});

const StoreSchema = z.object({
  v: z.literal(1),
  clients: z.array(PairedClientSchema).default([]),
  pendingEnrollments: z.array(PendingEnrollmentSchema).default([]),
});

export type PairedClient = z.infer<typeof PairedClientSchema>;
type StoredState = z.infer<typeof StoreSchema>;

export type ClientAuthorization =
  | { outcome: "known"; client: PairedClient }
  | { outcome: "enrolled"; client: PairedClient }
  | { outcome: "rejected"; reason: "unknown-client" | "invalid-enrollment" };

/**
 * Compares two secrets without leaking their relationship through timing.
 *
 * Lengths are compared first because timingSafeEqual throws on a mismatch; that
 * leaks only the length, which is fixed for tokens we mint.
 */
function secretsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Short, stable, human-quotable identifier for a client key. */
export function fingerprintPublicKey(publicKeyB64: string): string {
  return createHash("sha256").update(publicKeyB64).digest("hex").slice(0, 16);
}

/**
 * Approved client keys plus the outstanding pairing offers that can mint them.
 *
 * The daemon's keypair alone is not enough to open a session: a client either
 * presents a key this store already knows, or redeems a single-use enrollment
 * token from a pairing offer. That turns the pairing link from a standing
 * credential into a one-time invitation, and makes revocation possible.
 */
export class PairedClientStore {
  private readonly filePath: string;
  private readonly logger: pino.Logger | undefined;
  private state: StoredState = { v: 1, clients: [], pendingEnrollments: [] };

  constructor(paseoHome: string, logger?: pino.Logger) {
    this.filePath = path.join(paseoHome, PAIRED_CLIENTS_FILENAME);
    this.logger = logger?.child({ module: "paired-clients" });
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      return;
    }
    try {
      ensurePrivateFile(this.filePath);
      this.state = StoreSchema.parse(JSON.parse(readFileSync(this.filePath, "utf8")));
    } catch (error) {
      // Refusing every client is worse than starting empty: the operator can
      // always re-pair, but a corrupt file would otherwise lock them out with
      // no obvious remedy.
      this.logger?.warn({ err: error, filePath: this.filePath }, "Resetting paired clients");
      this.state = { v: 1, clients: [], pendingEnrollments: [] };
    }
  }

  private persist(): void {
    writePrivateFileAtomicSync(this.filePath, JSON.stringify(this.state, null, 2) + "\n");
  }

  private pruneExpired(nowMs: number): void {
    const kept = this.state.pendingEnrollments.filter((e) => e.expiresAtMs > nowMs);
    if (kept.length !== this.state.pendingEnrollments.length) {
      this.state.pendingEnrollments = kept;
    }
  }

  /** Mints a single-use token to embed in a pairing offer. */
  createEnrollment(options: { ttlMs?: number; nowMs?: number } = {}): string {
    const nowMs = options.nowMs ?? Date.now();
    this.pruneExpired(nowMs);
    const token = randomBytes(32).toString("base64url");
    this.state.pendingEnrollments.push({
      token,
      expiresAtMs: nowMs + (options.ttlMs ?? DEFAULT_ENROLLMENT_TTL_MS),
    });
    this.persist();
    return token;
  }

  /**
   * Decides whether a client completing the E2EE handshake may proceed.
   *
   * Redeeming an enrollment consumes it, so a leaked pairing link admits at
   * most the first device to use it — and the operator sees an unexpected
   * device in `paseo daemon clients` rather than nothing at all.
   */
  authorize(input: {
    publicKeyB64: string;
    enrollToken?: string | undefined;
    label?: string | null;
    nowMs?: number;
  }): ClientAuthorization {
    const nowMs = input.nowMs ?? Date.now();
    this.pruneExpired(nowMs);

    const existing = this.state.clients.find((c) =>
      secretsEqual(c.publicKeyB64, input.publicKeyB64),
    );
    if (existing) {
      existing.lastSeenAt = new Date(nowMs).toISOString();
      this.persist();
      return { outcome: "known", client: existing };
    }

    if (!input.enrollToken) {
      return { outcome: "rejected", reason: "unknown-client" };
    }

    const index = this.state.pendingEnrollments.findIndex((e) =>
      secretsEqual(e.token, input.enrollToken as string),
    );
    if (index === -1) {
      return { outcome: "rejected", reason: "invalid-enrollment" };
    }

    this.state.pendingEnrollments.splice(index, 1);
    const client: PairedClient = {
      publicKeyB64: input.publicKeyB64,
      fingerprint: fingerprintPublicKey(input.publicKeyB64),
      label: input.label ?? null,
      addedAt: new Date(nowMs).toISOString(),
      lastSeenAt: new Date(nowMs).toISOString(),
    };
    this.state.clients.push(client);
    this.persist();
    this.logger?.info({ fingerprint: client.fingerprint }, "Enrolled paired client");
    return { outcome: "enrolled", client };
  }

  list(): PairedClient[] {
    return this.state.clients.map((client) => ({ ...client }));
  }

  /** Returns the removed client's public key so live sessions can be closed. */
  revoke(fingerprint: string): PairedClient | null {
    const index = this.state.clients.findIndex((c) => c.fingerprint === fingerprint);
    if (index === -1) {
      return null;
    }
    const [removed] = this.state.clients.splice(index, 1);
    this.persist();
    this.logger?.info({ fingerprint }, "Revoked paired client");
    return removed ?? null;
  }

  /** Drops every client and outstanding offer. Used by key rotation. */
  revokeAll(): PairedClient[] {
    const removed = this.state.clients;
    this.state = { v: 1, clients: [], pendingEnrollments: [] };
    this.persist();
    this.logger?.info({ count: removed.length }, "Revoked all paired clients");
    return removed;
  }
}
