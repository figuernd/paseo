import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { HostRegistry } from "../hosts/host-registry.js";
import { ResolutionError } from "../tools/resolve.js";
import { createConnectorTools } from "../tools/voice-tools.js";

const INSTRUCTIONS = `Paseo runs AI coding agents on the user's own machines. Use these tools to start work, check on it, and answer what agents are blocked on.

This conversation may be spoken aloud, so keep replies to a sentence or two unless asked for detail, and never read out identifiers, file paths, or timestamps unless the user asks for them.

The user refers to hosts, workspaces, and agents by name, not by id — pass what they said and let the tool resolve it. If a tool reports an ambiguous match, ask which one they meant rather than picking.

When starting work, expand what the user said into a complete brief: the agent cannot ask follow-up questions once it is running.`;

export const CONNECTOR_SERVER_NAME = "paseo-connector";

export function createConnectorMcpServer(options: {
  registry: HostRegistry;
  version: string;
}): McpServer {
  const server = new McpServer(
    { name: CONNECTOR_SERVER_NAME, version: options.version },
    { instructions: INSTRUCTIONS },
  );

  for (const tool of createConnectorTools(options.registry)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args: unknown): Promise<CallToolResult> => {
        try {
          const result = await tool.handler((args ?? {}) as Record<string, unknown>);
          return {
            content: [{ type: "text", text: result.text }],
            ...(result.structured ? { structuredContent: result.structured } : {}),
            ...(result.isError ? { isError: true } : {}),
          };
        } catch (error) {
          // A failed turn is spoken to the user, so it says what to do next rather than throwing
          // a stack at them. Resolution failures already read as instructions.
          const message =
            error instanceof ResolutionError
              ? error.message
              : `That did not work: ${error instanceof Error ? error.message : String(error)}`;
          return { content: [{ type: "text", text: message }], isError: true };
        }
      },
    );
  }

  return server;
}
