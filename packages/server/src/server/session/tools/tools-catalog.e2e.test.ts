import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DaemonClient } from "../../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../../test-utils/paseo-daemon.js";

/**
 * The connector reaches every host the same way — over the session WebSocket — because a
 * relay-connected daemon has no HTTP surface to call. This proves that path against a real
 * daemon and its real tool catalog, which is the part a hand-built catalog cannot verify:
 * that the RPC is routed, validated on the way back in, and answered by the actual tools.
 */
describe("tools.catalog over the session protocol", () => {
  let daemon: TestPaseoDaemon;
  let client: DaemonClient;

  beforeAll(async () => {
    daemon = await createTestPaseoDaemon();
    client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.3.0",
    });
    await client.connect();
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await daemon?.close();
  });

  test("the daemon advertises the capability so old hosts can be told to update", () => {
    expect(client.getLastServerInfoMessage()?.features?.toolsCatalogRpc).toBe(true);
  });

  test("listing returns the real catalog with usable JSON Schema", async () => {
    const payload = await client.toolsCatalogList();

    expect(payload.error).toBeNull();
    const names = payload.tools.map((tool) => tool.name);
    expect(names).toContain("create_agent");
    expect(names).toContain("list_agents");
    expect(names).toContain("list_workspaces");
    expect(names).toContain("list_pending_permissions");

    const createAgent = payload.tools.find((tool) => tool.name === "create_agent");
    expect(createAgent?.description).toBeTypeOf("string");
    expect(createAgent?.inputSchema).toMatchObject({ type: "object" });
    expect(Object.keys((createAgent?.inputSchema?.properties ?? {}) as object)).toContain(
      "initialPrompt",
    );
  });

  test("calling a catalog tool runs it and returns its structured output", async () => {
    const payload = await client.toolsCatalogCall({ name: "list_agents", arguments: {} });

    expect(payload.error).toBeNull();
    expect(payload.isError).toBeUndefined();
    expect(payload.structuredContent).toMatchObject({ agents: [] });
  });

  test("a workspace created through the catalog is visible through the catalog", async () => {
    const created = await client.toolsCatalogCall({
      name: "create_workspace",
      arguments: { isolation: "local", path: daemon.paseoHome },
    });
    expect(created.error).toBeNull();

    const listed = await client.toolsCatalogCall({ name: "list_workspaces", arguments: {} });
    const workspaces = (listed.structuredContent as { workspaces: Array<{ cwd: string }> })
      .workspaces;
    expect(workspaces.map((workspace) => workspace.cwd)).toContain(daemon.paseoHome);
  });

  test("an unknown tool name comes back as an error payload, not a dropped request", async () => {
    const payload = await client.toolsCatalogCall({ name: "not_a_real_tool" });

    expect(payload.error).toBe("Unknown tool: not_a_real_tool");
    expect(payload.content).toEqual([]);
  });

  test("invalid arguments report the validation failure instead of hanging", async () => {
    const payload = await client.toolsCatalogCall({
      name: "get_agent_status",
      arguments: { agentId: 42 },
    });

    expect(payload.error).toBeTypeOf("string");
    expect(payload.error).not.toBeNull();
  });
});
