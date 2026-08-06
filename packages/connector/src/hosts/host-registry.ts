import { DaemonClient, type WebSocketLike } from "@getpaseo/client/internal/daemon-client";
import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";
import {
  buildDaemonWebSocketUrl,
  buildRelayWebSocketUrl,
  normalizeHostPort,
  parseConnectionUri,
  shouldUseTlsForDefaultHostedRelay,
} from "@getpaseo/protocol/daemon-endpoints";
import { WebSocket } from "ws";

import type { ConnectorHostConfig } from "../config.js";

export interface HostStatus {
  name: string;
  description?: string;
  connected: boolean;
  transport: "direct" | "relay";
  hostname: string | null;
  serverId: string | null;
  version: string | null;
  /** False when the daemon predates tools.catalog.* and cannot serve this connector. */
  supportsToolsCatalog: boolean;
  lastError: string | null;
}

export interface HostHandle {
  readonly name: string;
  readonly status: HostStatus;
  callTool(name: string, args: Record<string, unknown>): Promise<CatalogCallResult>;
  listTools(): Promise<CatalogToolDescriptor[]>;
}

export interface CatalogToolDescriptor {
  name: string;
  title?: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface CatalogCallResult {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface HostRegistryOptions {
  hosts: ConnectorHostConfig[];
  clientId: string;
  appVersion: string;
  connectTimeoutMs?: number;
  logger?: {
    info(obj: object, msg?: string): void;
    warn(obj: object, msg?: string): void;
    error(obj: object, msg?: string): void;
  };
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15000;

function nodeWebSocketFactory(
  url: string,
  options?: { headers?: Record<string, string>; protocols?: string[]; socketPath?: string },
): WebSocketLike {
  return new WebSocket(url, options?.protocols, {
    headers: options?.headers,
    ...(options?.socketPath ? { socketPath: options.socketPath } : {}),
  }) as unknown as WebSocketLike;
}

interface DirectTarget {
  kind: "direct";
  url: string;
  socketPath?: string;
  password?: string;
}

interface RelayTarget {
  kind: "relay";
  url: string;
  daemonPublicKeyB64: string;
  /**
   * Single-use enrollment token from the pairing offer. The daemon's public key is in every
   * offer and is not a credential; this is what admits the connector to a relay session.
   */
  enrollToken: string;
}

export type HostTarget = DirectTarget | RelayTarget;

/**
 * Endpoint strings are the same ones the CLI accepts, so a host you can reach with
 * `paseo --host` works here unchanged.
 */
export function resolveHostTarget(host: ConnectorHostConfig): HostTarget {
  if (host.offer) {
    const offer = parseConnectionOfferFromUrl(host.offer);
    if (!offer) {
      throw new Error(
        `Host ${host.name}: offer is not a Paseo pairing URL (it must carry the #offer= fragment).`,
      );
    }
    return {
      kind: "relay",
      url: buildRelayWebSocketUrl({
        endpoint: offer.relay.endpoint,
        serverId: offer.serverId,
        role: "client",
        useTls: offer.relay.useTls ?? shouldUseTlsForDefaultHostedRelay(offer.relay.endpoint),
      }),
      daemonPublicKeyB64: offer.daemonPublicKeyB64,
      enrollToken: offer.enroll,
    };
  }

  const endpoint = host.endpoint?.trim() ?? "";
  if (endpoint.startsWith("unix://") || endpoint.startsWith("pipe://")) {
    const socketPath = endpoint.slice("unix://".length).trim();
    if (!socketPath) {
      throw new Error(`Host ${host.name}: IPC endpoint is missing a socket path`);
    }
    return {
      kind: "direct",
      url: endpoint.startsWith("unix://") ? `ws+unix://${socketPath}:/ws` : "ws://localhost/ws",
      socketPath,
      ...(host.password ? { password: host.password } : {}),
    };
  }

  if (endpoint.startsWith("tcp://")) {
    const parsed = parseConnectionUri(endpoint);
    const normalized = normalizeHostPort(
      parsed.isIpv6 ? `[${parsed.host}]:${parsed.port}` : `${parsed.host}:${parsed.port}`,
    );
    const password = host.password ?? parsed.password;
    return {
      kind: "direct",
      url: buildDaemonWebSocketUrl(normalized, { useTls: parsed.useTls }),
      ...(password ? { password } : {}),
    };
  }

  return {
    kind: "direct",
    url: `ws://${normalizeHostPort(endpoint)}/ws`,
    ...(host.password ? { password: host.password } : {}),
  };
}

class HostConnection implements HostHandle {
  readonly name: string;
  private readonly config: ConnectorHostConfig;
  private readonly target: HostTarget;
  private readonly options: HostRegistryOptions;
  private client: DaemonClient | null = null;
  private connecting: Promise<DaemonClient> | null = null;
  private lastError: string | null = null;

  constructor(config: ConnectorHostConfig, options: HostRegistryOptions) {
    this.name = config.name;
    this.config = config;
    this.options = options;
    this.target = resolveHostTarget(config);
  }

  get status(): HostStatus {
    const info = this.client?.getLastServerInfoMessage() ?? null;
    return {
      name: this.name,
      ...(this.config.description ? { description: this.config.description } : {}),
      connected: this.client?.isConnected === true,
      transport: this.target.kind === "relay" ? "relay" : "direct",
      hostname: info?.hostname ?? null,
      serverId: info?.serverId ?? null,
      version: info?.version ?? null,
      supportsToolsCatalog: info?.features?.toolsCatalogRpc === true,
      lastError: this.lastError,
    };
  }

  async connect(): Promise<DaemonClient> {
    if (this.client?.isConnected) {
      return this.client;
    }
    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = this.openClient()
      .then((client) => {
        this.client = client;
        this.lastError = null;
        return client;
      })
      .catch((error: unknown) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      })
      .finally(() => {
        this.connecting = null;
      });

    return this.connecting;
  }

  private async openClient(): Promise<DaemonClient> {
    const target = this.target;
    const client = new DaemonClient({
      url: target.url,
      clientId: this.options.clientId,
      clientType: "cli",
      appVersion: this.options.appVersion,
      connectTimeoutMs: this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      ...(target.kind === "direct" && target.password ? { password: target.password } : {}),
      ...(target.kind === "relay"
        ? {
            e2ee: {
              enabled: true,
              daemonPublicKeyB64: target.daemonPublicKeyB64,
              enrollToken: target.enrollToken,
            },
          }
        : {}),
      webSocketFactory: (
        url: string,
        config?: { headers?: Record<string, string>; protocols?: string[] },
      ) =>
        nodeWebSocketFactory(url, {
          headers: config?.headers,
          protocols: config?.protocols,
          ...(target.kind === "direct" && target.socketPath
            ? { socketPath: target.socketPath }
            : {}),
        }),
      // A voice turn cannot wait out a manual reconnect, so hold the socket open between calls.
      reconnect: { enabled: true },
    });

    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }

  async listTools(): Promise<CatalogToolDescriptor[]> {
    const client = await this.connect();
    this.assertCatalogSupport();
    const payload = await client.toolsCatalogList();
    if (payload.error) {
      throw new Error(`${this.name}: ${payload.error}`);
    }
    return payload.tools.map((tool) => {
      const descriptor: CatalogToolDescriptor = { name: tool.name, description: tool.description };
      if (tool.title) {
        descriptor.title = tool.title;
      }
      if (tool.inputSchema) {
        descriptor.inputSchema = tool.inputSchema;
      }
      return descriptor;
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CatalogCallResult> {
    const client = await this.connect();
    this.assertCatalogSupport();
    const payload = await client.toolsCatalogCall({ name, arguments: args });
    if (payload.error) {
      throw new Error(`${this.name}: ${payload.error}`);
    }
    return {
      content: payload.content as CatalogCallResult["content"],
      ...(payload.structuredContent ? { structuredContent: payload.structuredContent } : {}),
      ...(payload.isError !== undefined ? { isError: payload.isError } : {}),
    };
  }

  private assertCatalogSupport(): void {
    if (!this.status.supportsToolsCatalog) {
      throw new Error(
        `Host ${this.name} runs a Paseo daemon that predates the tools.catalog RPC. Update that host to v0.3.0 or newer.`,
      );
    }
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => {});
    this.client = null;
  }
}

export interface HostRegistry {
  list(): HostHandle[];
  get(name: string): HostHandle | undefined;
  statuses(): HostStatus[];
  /** Opens every configured host so the first voice turn does not pay connect latency. */
  warmUp(): Promise<void>;
  close(): Promise<void>;
}

export function createHostRegistry(options: HostRegistryOptions): HostRegistry {
  const connections = options.hosts.map((host) => new HostConnection(host, options));
  const byName = new Map(
    connections.map((connection) => [connection.name.toLowerCase(), connection]),
  );

  return {
    list: () => [...connections],
    get: (name) => byName.get(name.trim().toLowerCase()),
    statuses: () => connections.map((connection) => connection.status),
    async warmUp() {
      await Promise.all(
        connections.map(async (connection) => {
          try {
            await connection.connect();
            options.logger?.info({ host: connection.name }, "Connected to Paseo host");
          } catch (error) {
            options.logger?.warn(
              { host: connection.name, err: error },
              "Could not reach Paseo host at startup; will retry on first use",
            );
          }
        }),
      );
    },
    async close() {
      await Promise.all(connections.map((connection) => connection.close()));
    },
  };
}
