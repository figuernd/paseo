import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface RegisteredClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
}

export interface AuthorizationCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  expiresAt: number;
}

export interface IssuedToken {
  /** SHA-256 of the token. The token itself is never written to disk. */
  tokenHash: string;
  clientId: string;
  resource: string;
  scope: string;
  expiresAt: number;
}

interface PersistedState {
  version: 1;
  clients: RegisteredClient[];
  accessTokens: IssuedToken[];
  refreshTokens: IssuedToken[];
}

export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Compares without leaking length or position through timing. */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

export function verifyPkceS256(verifier: string, challenge: string): boolean {
  const computed = createHash("sha256").update(verifier).digest("base64url");
  return safeEqual(computed, challenge);
}

export interface OAuthStore {
  registerClient(input: { clientName: string; redirectUris: string[] }): RegisteredClient;
  getClient(clientId: string): RegisteredClient | undefined;
  issueCode(input: Omit<AuthorizationCode, "code" | "expiresAt">): string;
  /** Codes are single-use: a redeemed or expired code is gone whether or not the exchange succeeds. */
  consumeCode(code: string): AuthorizationCode | undefined;
  issueTokens(input: { clientId: string; resource: string; scope: string }): {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  };
  verifyAccessToken(token: string, resource: string): IssuedToken | undefined;
  consumeRefreshToken(token: string, clientId: string): IssuedToken | undefined;
}

export function createOAuthStore(options: { statePath: string; now?: () => number }): OAuthStore {
  const now = options.now ?? (() => Date.now());
  const codes = new Map<string, AuthorizationCode>();

  let state: PersistedState = { version: 1, clients: [], accessTokens: [], refreshTokens: [] };
  try {
    const parsed = JSON.parse(readFileSync(options.statePath, "utf-8")) as PersistedState;
    if (parsed?.version === 1) {
      state = {
        version: 1,
        clients: parsed.clients ?? [],
        accessTokens: parsed.accessTokens ?? [],
        refreshTokens: parsed.refreshTokens ?? [],
      };
    }
  } catch {
    // A missing or unreadable state file just means nothing is paired yet.
  }

  function persist(): void {
    const current = now();
    state.accessTokens = state.accessTokens.filter((token) => token.expiresAt > current);
    state.refreshTokens = state.refreshTokens.filter((token) => token.expiresAt > current);
    mkdirSync(path.dirname(options.statePath), { recursive: true });
    const tempPath = `${options.statePath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tempPath, options.statePath);
  }

  return {
    registerClient(input) {
      const client: RegisteredClient = {
        clientId: `paseo-connector-${newSecret(12)}`,
        clientName: input.clientName,
        redirectUris: input.redirectUris,
        createdAt: now(),
      };
      state.clients.push(client);
      persist();
      return client;
    },

    getClient(clientId) {
      return state.clients.find((client) => client.clientId === clientId);
    },

    issueCode(input) {
      const code = newSecret();
      codes.set(code, { ...input, code, expiresAt: now() + CODE_TTL_MS });
      return code;
    },

    consumeCode(code) {
      const entry = codes.get(code);
      codes.delete(code);
      if (!entry || entry.expiresAt <= now()) {
        return undefined;
      }
      return entry;
    },

    issueTokens({ clientId, resource, scope }) {
      const accessToken = newSecret();
      const refreshToken = newSecret();
      const current = now();
      state.accessTokens.push({
        tokenHash: hashToken(accessToken),
        clientId,
        resource,
        scope,
        expiresAt: current + ACCESS_TOKEN_TTL_MS,
      });
      state.refreshTokens.push({
        tokenHash: hashToken(refreshToken),
        clientId,
        resource,
        scope,
        expiresAt: current + REFRESH_TOKEN_TTL_MS,
      });
      persist();
      return { accessToken, refreshToken, expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000) };
    },

    verifyAccessToken(token, resource) {
      const tokenHash = hashToken(token);
      const entry = state.accessTokens.find((candidate) => candidate.tokenHash === tokenHash);
      if (!entry || entry.expiresAt <= now()) {
        return undefined;
      }
      // RFC 8707: a token minted for some other resource must not be accepted here.
      if (entry.resource !== resource) {
        return undefined;
      }
      return entry;
    },

    consumeRefreshToken(token, clientId) {
      const tokenHash = hashToken(token);
      const index = state.refreshTokens.findIndex((candidate) => candidate.tokenHash === tokenHash);
      if (index === -1) {
        return undefined;
      }
      const entry = state.refreshTokens[index] as IssuedToken;
      // Public clients get rotating refresh tokens, so the old one dies on use either way.
      state.refreshTokens.splice(index, 1);
      persist();
      if (entry.expiresAt <= now() || entry.clientId !== clientId) {
        return undefined;
      }
      return entry;
    },
  };
}
