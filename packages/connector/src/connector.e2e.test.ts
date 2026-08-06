import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { ConnectorConfig } from "./config.js";
import type {
  CatalogCallResult,
  HostHandle,
  HostRegistry,
  HostStatus,
} from "./hosts/host-registry.js";
import { createConnectorApp } from "./server.js";

/**
 * Drives the connector the way Claude does: a real MCP client, over real HTTP, through the OAuth
 * flow, against the real express app and the real tool implementations. The daemon behind it is
 * the only stand-in — the daemon side of the same path is covered by the server package's
 * tools-catalog e2e.
 */
const PAIRING_CODE = "pairing-code-for-tests";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

const calls: Array<{ name: string; args: Record<string, unknown> }> = [];

const fakeHost: HostHandle = {
  name: "mac mini",
  get status(): HostStatus {
    return {
      name: "mac mini",
      connected: true,
      transport: "relay",
      hostname: "studio.local",
      serverId: "srv-1",
      version: "0.3.0",
      supportsToolsCatalog: true,
      lastError: null,
    };
  },
  async listTools() {
    return [{ name: "create_schedule", description: "Create a cron schedule." }];
  },
  async callTool(name, args): Promise<CatalogCallResult> {
    calls.push({ name, args });
    switch (name) {
      case "list_providers":
        return {
          content: [],
          structuredContent: {
            providers: [{ id: "claude", available: true, defaultModel: "opus" }],
          },
        };
      case "list_workspaces":
        return {
          content: [],
          structuredContent: {
            workspaces: [
              {
                workspaceId: "ws-1",
                cwd: "/repos/paseo",
                title: "paseo",
                isolation: "local",
                kind: "directory",
              },
            ],
          },
        };
      case "list_agents":
        return { content: [], structuredContent: { agents: [] } };
      case "create_agent":
        return {
          content: [],
          structuredContent: { agentId: "agt_1", cwd: "/repos/paseo", status: "running" },
        };
      default:
        return { content: [], structuredContent: { success: true } };
    }
  },
};

const registry: HostRegistry = {
  list: () => [fakeHost],
  get: () => fakeHost,
  statuses: () => [fakeHost.status],
  warmUp: async () => {},
  close: async () => {},
};

let workDir: string;
let server: Server;
let origin: string;
let client: Client;

async function authorize(): Promise<string> {
  const registered = await fetch(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT_URI] }),
  });
  const { client_id: clientId } = (await registered.json()) as { client_id: string };

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const approved = await fetch(`${origin}/oauth/approve`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      resource: `${origin}/mcp`,
      pairingCode: PAIRING_CODE,
    }),
    redirect: "manual",
  });
  const code = new URL(approved.headers.get("location") as string).searchParams.get(
    "code",
  ) as string;

  const token = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
    }),
  });
  const { access_token: accessToken } = (await token.json()) as { access_token: string };
  return accessToken;
}

beforeAll(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "paseo-connector-e2e-"));

  const probe = createConnectorApp({
    config: config("http://127.0.0.1:1"),
    version: "test",
    clientId: "test",
    registry,
  }).app;
  const probeServer = await new Promise<Server>((resolve) => {
    const listening = probe.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const port = (probeServer.address() as { port: number }).port;
  await new Promise<void>((resolve) => probeServer.close(() => resolve()));

  origin = `http://127.0.0.1:${port}`;
  const app = createConnectorApp({
    config: config(origin),
    version: "test",
    clientId: "test",
    registry,
  }).app;
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(port, "127.0.0.1", () => resolve(listening));
  });

  const accessToken = await authorize();
  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    }),
  );
}, 60_000);

afterAll(async () => {
  await client?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(workDir, { recursive: true, force: true });
});

function config(publicUrl: string): ConnectorConfig {
  return {
    listen: { host: "127.0.0.1", port: 0 },
    publicUrl,
    pairingCode: PAIRING_CODE,
    hosts: [],
    configPath: path.join(workDir, "connector.json"),
  };
}

describe("connector over MCP", () => {
  test("advertises the voice tool surface and the escape hatch", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();

    expect(names).toEqual([
      "answer_permission",
      "archive_work",
      "check_work",
      "list_hosts",
      "list_paseo_tools",
      "list_permissions",
      "list_work",
      "list_workspaces",
      "run_paseo_tool",
      "send_message",
      "start_work",
      "stop_work",
    ]);
  });

  test("every tool carries a description, since that is all voice has to choose by", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(40);
    }
  });

  test("list_hosts answers in a sentence", async () => {
    const result = await client.callTool({ name: "list_hosts", arguments: {} });
    const [content] = result.content as Array<{ type: string; text: string }>;
    expect(content.text).toBe("1 host: mac mini is online.");
  });

  test("start_work reaches the host and creates a background agent", async () => {
    calls.length = 0;
    const result = await client.callTool({
      name: "start_work",
      arguments: { task: "Add a health check endpoint to the API.", workspace: "paseo" },
    });

    expect(calls.find((call) => call.name === "create_agent")?.args).toMatchObject({
      title: "Add a health check endpoint to the API",
      provider: "claude/opus",
      initialPrompt: "Add a health check endpoint to the API.",
      workspaceId: "ws-1",
      background: true,
    });
    const [content] = result.content as Array<{ type: string; text: string }>;
    expect(content.text).toBe(
      'Started "Add a health check endpoint to the API" on mac mini in paseo. It is running in the background.',
    );
  });

  test("a failed resolution comes back as a spoken instruction, not a protocol error", async () => {
    const result = await client.callTool({
      name: "check_work",
      arguments: { agent: "something that does not exist" },
    });

    expect(result.isError).toBe(true);
    const [content] = result.content as Array<{ type: string; text: string }>;
    expect(content.text).toBe(
      'There are no agents to match "something that does not exist" against.',
    );
  });

  test("the escape hatch forwards an arbitrary catalog call", async () => {
    calls.length = 0;
    await client.callTool({
      name: "run_paseo_tool",
      arguments: {
        tool: "create_schedule",
        arguments: { cron: "0 9 * * 1", prompt: "Weekly review" },
      },
    });

    expect(calls.at(-1)).toEqual({
      name: "create_schedule",
      args: { cron: "0 9 * * 1", prompt: "Weekly review" },
    });
  });
});
