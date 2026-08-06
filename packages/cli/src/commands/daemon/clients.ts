import type { Command } from "commander";
import type { CommandOptions, OutputSchema, SingleResult } from "../../output/index.js";
import { connectToDaemon } from "../../utils/client.js";

interface ClientRow {
  fingerprint: string;
  label: string;
  addedAt: string;
  lastSeenAt: string;
}

interface ClientsListResult {
  action: "clients_listed";
  clients: ClientRow[];
  message: string;
}

interface ClientsRevokeResult {
  action: "clients_revoked";
  revoked: ClientRow[];
  sessionsClosed: number;
  message: string;
}

function toRow(client: {
  fingerprint: string;
  label?: string | null;
  addedAt: string;
  lastSeenAt?: string | null;
}): ClientRow {
  return {
    fingerprint: client.fingerprint,
    label: client.label ?? "",
    addedAt: client.addedAt,
    lastSeenAt: client.lastSeenAt ?? "never",
  };
}

const listSchema: OutputSchema<ClientsListResult> = {
  idField: "action",
  columns: [
    { header: "STATUS", field: "action", color: () => "green" },
    { header: "CLIENTS", field: "message" },
  ],
  renderHuman: (result) => {
    const data = result.data as ClientsListResult;
    if (data.clients.length === 0) {
      return "No paired clients. Run `paseo daemon pair` to add one.";
    }
    const rows = data.clients.map(
      (client) =>
        `${client.fingerprint}  ${client.label || "(unlabelled)"}  paired ${client.addedAt}  last seen ${client.lastSeenAt}`,
    );
    return [`${data.clients.length} paired client(s):`, ...rows].join("\n");
  },
};

const revokeSchema: OutputSchema<ClientsRevokeResult> = {
  idField: "action",
  columns: [
    { header: "STATUS", field: "action", color: () => "green" },
    { header: "RESULT", field: "message" },
  ],
  renderHuman: (result) => (result.data as ClientsRevokeResult).message,
};

export async function runClientsListCommand(
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<ClientsListResult>> {
  const client = await connectToDaemon({ host: options.host as string | undefined });
  try {
    const response = await client.listPairedClients();
    const clients = response.clients.map(toRow);
    return {
      type: "single",
      data: {
        action: "clients_listed",
        clients,
        message: `${clients.length} paired client(s)`,
      },
      schema: listSchema,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

export async function runClientsRevokeCommand(
  fingerprint: string,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<ClientsRevokeResult>> {
  const client = await connectToDaemon({ host: options.host as string | undefined });
  try {
    const response = await client.revokePairedClients(fingerprint);
    const revoked = response.revoked.map(toRow);
    const message =
      revoked.length === 0
        ? `No paired client matches ${fingerprint}`
        : `Revoked ${revoked.length} client(s); closed ${response.sessionsClosed} live session(s)`;
    return {
      type: "single",
      data: {
        action: "clients_revoked",
        revoked,
        sessionsClosed: response.sessionsClosed,
        message,
      },
      schema: revokeSchema,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

export async function runRotateKeyCommand(
  options: CommandOptions,
  command: Command,
): Promise<SingleResult<ClientsRevokeResult>> {
  return runClientsRevokeCommand("all", options, command);
}
