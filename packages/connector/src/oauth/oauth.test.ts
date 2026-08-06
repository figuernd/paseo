import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { ConnectorConfig } from "../config.js";
import type { HostRegistry } from "../hosts/host-registry.js";
import { createConnectorApp } from "../server.js";

// The whole point of this suite is that a real MCP client can complete the real flow, so it runs
// against a real listening server over real HTTP. Nothing here is mocked except the Paseo hosts,
// which are irrelevant to authorization.
const PAIRING_CODE = "correct-horse-battery";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

const emptyRegistry: HostRegistry = {
  list: () => [],
  get: () => undefined,
  statuses: () => [],
  warmUp: async () => {},
  close: async () => {},
};

let workDir: string;
let server: Server;
let origin: string;

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function registerClient(): Promise<string> {
  const response = await fetch(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT_URI] }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { client_id: string };
  return body.client_id;
}

async function approve(params: {
  clientId: string;
  challenge: string;
  pairingCode: string;
  state?: string;
}): Promise<Response> {
  const form = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: params.challenge,
    resource: `${origin}/mcp`,
    pairingCode: params.pairingCode,
    ...(params.state ? { state: params.state } : {}),
  });
  return await fetch(`${origin}/oauth/approve`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
    redirect: "manual",
  });
}

function codeFrom(response: Response): string {
  const location = response.headers.get("location");
  expect(location).not.toBeNull();
  const code = new URL(location as string).searchParams.get("code");
  expect(code).not.toBeNull();
  return code as string;
}

async function exchange(params: {
  clientId: string;
  code: string;
  verifier: string;
}): Promise<Response> {
  return await fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      code_verifier: params.verifier,
      client_id: params.clientId,
      redirect_uri: REDIRECT_URI,
    }),
  });
}

async function fullFlow(): Promise<{
  accessToken: string;
  refreshToken: string;
  clientId: string;
}> {
  const clientId = await registerClient();
  const { verifier, challenge } = pkcePair();
  const code = codeFrom(await approve({ clientId, challenge, pairingCode: PAIRING_CODE }));
  const response = await exchange({ clientId, code, verifier });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { access_token: string; refresh_token: string };
  return { accessToken: body.access_token, refreshToken: body.refresh_token, clientId };
}

beforeEach(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "paseo-connector-oauth-"));
  const listener = await new Promise<Server>((resolve, reject) => {
    // Bind first to learn the port, then rebuild the app with a publicUrl that matches it — the
    // resource identifier has to be the origin the client actually calls.
    const probe = createConnectorApp({
      config: baseConfig("http://127.0.0.1:1"),
      version: "test",
      clientId: "test",
      registry: emptyRegistry,
    }).app.listen(0, "127.0.0.1", () => resolve(probe));
    probe.on("error", reject);
  });
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));

  origin = `http://127.0.0.1:${port}`;
  const { app } = createConnectorApp({
    config: baseConfig(origin),
    version: "test",
    clientId: "test",
    registry: emptyRegistry,
  });
  server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(port, "127.0.0.1", () => resolve(listening));
    listening.on("error", reject);
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(workDir, { recursive: true, force: true });
});

function baseConfig(publicUrl: string): ConnectorConfig {
  return {
    listen: { host: "127.0.0.1", port: 0 },
    publicUrl,
    pairingCode: PAIRING_CODE,
    hosts: [],
    configPath: path.join(workDir, "connector.json"),
  };
}

describe("discovery documents", () => {
  test("protected resource metadata points at this connector as its own authorization server", async () => {
    const response = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      scopes_supported: ["paseo"],
    });
  });

  test("authorization server metadata advertises PKCE and dynamic registration", async () => {
    const response = await fetch(`${origin}/.well-known/oauth-authorization-server`);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.issuer).toBe(origin);
    expect(body.registration_endpoint).toBe(`${origin}/oauth/register`);
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
  });
});

describe("authorization", () => {
  test("an unauthenticated MCP request is challenged with the resource metadata location", async () => {
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer realm="paseo-connector", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  test("the full authorization code flow issues a token that reaches the MCP endpoint", async () => {
    const { accessToken } = await fullFlow();

    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    });
    expect(response.status).toBe(200);
  });

  test("a wrong pairing code re-prompts instead of issuing a code", async () => {
    const clientId = await registerClient();
    const { challenge } = pkcePair();
    const response = await approve({ clientId, challenge, pairingCode: "wrong" });
    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toContain("That pairing code is not right.");
  });

  test("state is round-tripped to the redirect so the client can match its request", async () => {
    const clientId = await registerClient();
    const { challenge } = pkcePair();
    const response = await approve({
      clientId,
      challenge,
      pairingCode: PAIRING_CODE,
      state: "opaque-state-value",
    });
    const location = new URL(response.headers.get("location") as string);
    expect(location.searchParams.get("state")).toBe("opaque-state-value");
  });

  test("a code cannot be redeemed with the wrong PKCE verifier", async () => {
    const clientId = await registerClient();
    const { challenge } = pkcePair();
    const code = codeFrom(await approve({ clientId, challenge, pairingCode: PAIRING_CODE }));

    const response = await exchange({ clientId, code, verifier: "not-the-verifier" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_grant" });
  });

  test("a code is single use", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkcePair();
    const code = codeFrom(await approve({ clientId, challenge, pairingCode: PAIRING_CODE }));

    expect((await exchange({ clientId, code, verifier })).status).toBe(200);
    const replay = await exchange({ clientId, code, verifier });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: "invalid_grant" });
  });

  test("authorize rejects a redirect_uri that was not registered", async () => {
    const clientId = await registerClient();
    const { challenge } = pkcePair();
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: "https://attacker.example/callback",
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const response = await fetch(`${origin}/oauth/authorize?${query}`, { redirect: "manual" });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("redirect_uri does not match");
  });

  test("authorize refuses to run without PKCE", async () => {
    const clientId = await registerClient();
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
    });
    const response = await fetch(`${origin}/oauth/authorize?${query}`);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("PKCE");
  });

  test("registration rejects a non-https redirect URI", async () => {
    const response = await fetch(`${origin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "x", redirect_uris: ["http://evil.example/cb"] }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_redirect_uri" });
  });

  test("a refresh token mints a new access token and is then spent", async () => {
    const { refreshToken, clientId } = await fullFlow();

    const refreshed = await fetch(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      }),
    });
    expect(refreshed.status).toBe(200);
    const body = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect(body.access_token).toBeTypeOf("string");
    expect(body.refresh_token).not.toBe(refreshToken);

    const replay = await fetch(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      }),
    });
    expect(replay.status).toBe(400);
  });

  test("a made-up bearer token is rejected", async () => {
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer not-a-real-token",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
  });
});
