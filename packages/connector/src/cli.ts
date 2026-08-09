import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { resolveConnectorConfig } from "./config.js";
import { startConnector } from "./server.js";

function resolveVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  const config = resolveConnectorConfig();
  const { close } = await startConnector({
    config,
    version: resolveVersion(),
    clientId: process.env.PASEO_CONNECTOR_CLIENT_ID?.trim() || `connector-${randomUUID()}`,
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void close().then(() => process.exit(0));
    });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
