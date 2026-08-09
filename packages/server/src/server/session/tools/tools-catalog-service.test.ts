import { describe, expect, test } from "vitest";
import { z } from "zod";

import type { PaseoToolCatalog, PaseoToolDefinition } from "../../agent/tools/types.js";
import { createToolsCatalogService } from "./tools-catalog-service.js";

/**
 * The real catalog is built from the daemon's whole agent stack. What this service owes its
 * callers is narrower: describe the tools in a shape a remote client can use, run one by name,
 * and turn every failure into a payload rather than a thrown RPC. A hand-built catalog with the
 * real interface exercises exactly that.
 */
function catalogOf(...tools: PaseoToolDefinition[]): PaseoToolCatalog {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    tools: byName,
    getTool: (name) => byName.get(name),
    async executeTool(name, input, context) {
      const tool = byName.get(name);
      if (!tool) {
        throw new Error(`Unknown tool: ${name}`);
      }
      return await tool.handler(input, context ?? {});
    },
  };
}

const echoTool: PaseoToolDefinition = {
  name: "echo",
  title: "Echo",
  description: "Echo the message back.",
  inputSchema: { message: z.string().describe("What to echo."), times: z.number().optional() },
  handler: async (input) => ({
    content: [{ type: "text", text: String((input as { message: string }).message) }],
    structuredContent: { echoed: (input as { message: string }).message },
  }),
};

const explodingTool: PaseoToolDefinition = {
  name: "explode",
  description: "Always throws.",
  inputSchema: {},
  handler: async () => {
    throw new Error("workspace registry is not configured");
  },
};

describe("tools.catalog.list", () => {
  test("describes each tool with JSON Schema a remote client can render", async () => {
    const service = createToolsCatalogService({ buildCatalog: async () => catalogOf(echoTool) });

    const payload = await service.handleListRequest({
      type: "tools.catalog.list.request",
      requestId: "req-1",
    });

    expect(payload.error).toBeNull();
    expect(payload.tools).toHaveLength(1);
    const [tool] = payload.tools;
    expect(tool).toMatchObject({
      name: "echo",
      title: "Echo",
      description: "Echo the message back.",
    });
    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        message: { type: "string", description: "What to echo." },
        times: { type: "number" },
      },
      required: ["message"],
    });
  });

  test("reports the daemon having no catalog instead of returning an empty one silently", async () => {
    const service = createToolsCatalogService({ buildCatalog: async () => null });

    const payload = await service.handleListRequest({
      type: "tools.catalog.list.request",
      requestId: "req-2",
    });

    expect(payload).toEqual({
      requestId: "req-2",
      tools: [],
      error: "This daemon has no Paseo tool catalog configured",
    });
  });

  test("a tool whose schema cannot be serialized is still listed", async () => {
    const opaque: PaseoToolDefinition = {
      name: "opaque",
      description: "Has a schema that will not convert.",
      inputSchema: { handle: z.custom<() => void>() },
      handler: async () => ({ content: [] }),
    };
    const service = createToolsCatalogService({ buildCatalog: async () => catalogOf(opaque) });

    const payload = await service.handleListRequest({
      type: "tools.catalog.list.request",
      requestId: "req-3",
    });

    expect(payload.error).toBeNull();
    expect(payload.tools.map((tool) => tool.name)).toEqual(["opaque"]);
  });
});

describe("tools.catalog.call", () => {
  test("runs the named tool and returns its content and structured output", async () => {
    const service = createToolsCatalogService({ buildCatalog: async () => catalogOf(echoTool) });

    const payload = await service.handleCallRequest({
      type: "tools.catalog.call.request",
      requestId: "req-4",
      name: "echo",
      arguments: { message: "hello" },
    });

    expect(payload).toEqual({
      requestId: "req-4",
      content: [{ type: "text", text: "hello" }],
      structuredContent: { echoed: "hello" },
      error: null,
    });
  });

  test("an unknown tool name is an error payload, not a thrown RPC", async () => {
    const service = createToolsCatalogService({ buildCatalog: async () => catalogOf(echoTool) });

    const payload = await service.handleCallRequest({
      type: "tools.catalog.call.request",
      requestId: "req-5",
      name: "no_such_tool",
    });

    expect(payload).toEqual({
      requestId: "req-5",
      content: [],
      error: "Unknown tool: no_such_tool",
    });
  });

  test("a tool that throws reports its message back to the caller", async () => {
    const service = createToolsCatalogService({
      buildCatalog: async () => catalogOf(explodingTool),
    });

    const payload = await service.handleCallRequest({
      type: "tools.catalog.call.request",
      requestId: "req-6",
      name: "explode",
    });

    expect(payload).toEqual({
      requestId: "req-6",
      content: [],
      error: "workspace registry is not configured",
    });
  });

  test("omitted arguments reach the tool as an empty object", async () => {
    let received: unknown;
    const recorder: PaseoToolDefinition = {
      name: "record",
      description: "Records its input.",
      inputSchema: {},
      handler: async (input) => {
        received = input;
        return { content: [] };
      },
    };
    const service = createToolsCatalogService({ buildCatalog: async () => catalogOf(recorder) });

    await service.handleCallRequest({
      type: "tools.catalog.call.request",
      requestId: "req-7",
      name: "record",
    });

    expect(received).toEqual({});
  });
});
