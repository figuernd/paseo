import type { IncomingMessage, Server, ServerResponse } from "node:http";
import path from "node:path";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";

import type { ConnectorConfig } from "./config.js";
import { createHostRegistry, type HostRegistry } from "./hosts/host-registry.js";
import { createConnectorMcpServer } from "./mcp/server.js";
import { createOAuthSubsystem, MCP_PATH, type OAuthSubsystem } from "./oauth/routes.js";

export interface ConnectorLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface ConnectorApp {
  app: express.Express;
  registry: HostRegistry;
  oauth: OAuthSubsystem;
}

const consoleLogger: ConnectorLogger = {
  info: (obj, msg) => console.log(msg ?? "", obj),
  warn: (obj, msg) => console.warn(msg ?? "", obj),
  error: (obj, msg) => console.error(msg ?? "", obj),
};

export function createConnectorApp(options: {
  config: ConnectorConfig;
  version: string;
  clientId: string;
  logger?: ConnectorLogger;
  registry?: HostRegistry;
  oauth?: OAuthSubsystem;
}): ConnectorApp {
  const logger = options.logger ?? consoleLogger;
  const registry =
    options.registry ??
    createHostRegistry({
      hosts: options.config.hosts,
      clientId: options.clientId,
      appVersion: options.version,
      logger,
    });

  const oauth =
    options.oauth ??
    createOAuthSubsystem({
      publicUrl: options.config.publicUrl,
      pairingCode: options.config.pairingCode,
      statePath: path.join(path.dirname(options.config.configPath), "connector-oauth.json"),
    });

  const app = express();
  app.disable("x-powered-by");
  app.use(oauth.router);

  app.get("/health", (_req, res) => {
    res.json({ ok: true, hosts: registry.statuses() });
  });

  const runMcpRequest = async (req: express.Request, res: express.Response): Promise<void> => {
    if (!oauth.authenticate(req.header("authorization"))) {
      // RFC 9728 5.1: the challenge is how an unauthenticated client discovers where to go.
      res
        .status(401)
        .setHeader("WWW-Authenticate", oauth.challengeHeader())
        .json({ error: "invalid_token" });
      return;
    }

    // Stateless, like the daemon's own MCP route: a fresh server and transport per request, torn
    // down when the response closes. Nothing here needs cross-request state, and sessions that
    // never receive a clean DELETE would pin memory for the life of the process.
    const server = createConnectorMcpServer({ registry, version: options.version });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // The public origin terminates TLS and is matched by the OAuth resource identifier, so the
      // transport's exact-Host check would only reject legitimate proxied requests.
      enableDnsRebindingProtection: false,
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
        req.body,
      );
    } catch (error) {
      logger.error({ err: error }, "MCP request failed");
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal error" },
          id: null,
        });
      }
    }
  };

  // runMcpRequest handles its own failures, so nothing can escape into an unhandled rejection.
  const handleMcpRequest: express.RequestHandler = (req, res) => {
    void runMcpRequest(req, res);
  };

  app.post(MCP_PATH, express.json({ limit: "4mb" }), handleMcpRequest);

  // Stateless mode has no standalone SSE stream and no session to terminate.
  app.all(MCP_PATH, (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null,
    });
  });

  return { app, registry, oauth };
}

export async function startConnector(options: {
  config: ConnectorConfig;
  version: string;
  clientId: string;
  logger?: ConnectorLogger;
}): Promise<{ server: Server; registry: HostRegistry; close: () => Promise<void> }> {
  const logger = options.logger ?? consoleLogger;
  const { app, registry } = createConnectorApp(options);

  const server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(options.config.listen.port, options.config.listen.host, () => {
      resolve(listener);
    });
    listener.on("error", reject);
  });

  logger.info(
    {
      listen: `${options.config.listen.host}:${options.config.listen.port}`,
      publicUrl: options.config.publicUrl,
      hosts: options.config.hosts.length,
    },
    "Paseo connector listening",
  );

  await registry.warmUp();

  return {
    server,
    registry,
    async close() {
      await registry.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
