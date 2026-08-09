import { z } from "zod";

import type {
  PaseoToolDescriptor,
  ToolsCatalogCallPayload,
  ToolsCatalogCallRequest,
  ToolsCatalogListPayload,
  ToolsCatalogListRequest,
} from "../../messages.js";
import type { PaseoToolCatalog, PaseoToolResult } from "../../agent/tools/types.js";

export interface ToolsCatalogServiceDependencies {
  /** Returns null when the daemon has no catalog wired (MCP disabled). */
  buildCatalog: () => Promise<PaseoToolCatalog | null>;
}

export interface ToolsCatalogService {
  handleListRequest(msg: ToolsCatalogListRequest): Promise<ToolsCatalogListPayload>;
  handleCallRequest(
    msg: ToolsCatalogCallRequest,
    context?: { signal?: AbortSignal },
  ): Promise<ToolsCatalogCallPayload>;
}

const CATALOG_UNAVAILABLE = "This daemon has no Paseo tool catalog configured";

/**
 * Tool input schemas are authored as Zod raw shapes so the MCP SDK can register them directly.
 * Over the wire they have to be JSON Schema, and a shape is not itself a Zod type, so wrap the
 * raw-shape case before converting. A tool whose schema cannot be converted is still listed —
 * losing argument hints is better than hiding the tool.
 */
function toJsonSchema(inputSchema: unknown): Record<string, unknown> | undefined {
  if (!inputSchema) {
    return undefined;
  }
  try {
    const schema =
      inputSchema instanceof z.ZodType ? inputSchema : z.object(inputSchema as z.ZodRawShape);
    return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

function describeTools(catalog: PaseoToolCatalog): PaseoToolDescriptor[] {
  const descriptors: PaseoToolDescriptor[] = [];
  for (const tool of catalog.tools.values()) {
    const descriptor: PaseoToolDescriptor = { name: tool.name, description: tool.description };
    if (tool.title) {
      descriptor.title = tool.title;
    }
    const inputSchema = toJsonSchema(tool.inputSchema);
    if (inputSchema) {
      descriptor.inputSchema = inputSchema;
    }
    descriptors.push(descriptor);
  }
  return descriptors;
}

function toCallPayload(requestId: string, result: PaseoToolResult): ToolsCatalogCallPayload {
  return {
    requestId,
    content: result.content as ToolsCatalogCallPayload["content"],
    ...(result.structuredContent !== undefined && result.structuredContent !== null
      ? { structuredContent: result.structuredContent as Record<string, unknown> }
      : {}),
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
    error: null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createToolsCatalogService(
  deps: ToolsCatalogServiceDependencies,
): ToolsCatalogService {
  return {
    async handleListRequest(msg) {
      try {
        const catalog = await deps.buildCatalog();
        if (!catalog) {
          return { requestId: msg.requestId, tools: [], error: CATALOG_UNAVAILABLE };
        }
        return { requestId: msg.requestId, tools: describeTools(catalog), error: null };
      } catch (error) {
        return { requestId: msg.requestId, tools: [], error: errorMessage(error) };
      }
    },

    async handleCallRequest(msg, context) {
      try {
        const catalog = await deps.buildCatalog();
        if (!catalog) {
          return { requestId: msg.requestId, content: [], error: CATALOG_UNAVAILABLE };
        }
        if (!catalog.getTool(msg.name)) {
          return {
            requestId: msg.requestId,
            content: [],
            error: `Unknown tool: ${msg.name}`,
          };
        }
        const result = await catalog.executeTool(
          msg.name,
          msg.arguments ?? {},
          context?.signal ? { signal: context.signal } : {},
        );
        return toCallPayload(msg.requestId, result);
      } catch (error) {
        return { requestId: msg.requestId, content: [], error: errorMessage(error) };
      }
    },
  };
}
