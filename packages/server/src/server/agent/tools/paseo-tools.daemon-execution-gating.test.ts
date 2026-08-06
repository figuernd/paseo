import { describe, expect, it } from "vitest";
import pino from "pino";

import { createStub } from "../../test-utils/class-mocks.js";
import { createPaseoToolCatalog, type PaseoToolHostDependencies } from "./paseo-tools.js";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import type { ProviderSnapshotManager } from "../../provider-snapshot-manager.js";
import type { TerminalManager } from "../../terminal/terminal-manager.js";

// Tools that run a command in a daemon-owned process. Those processes are
// children of the daemon, so they do not inherit the calling agent's sandbox.
// start_workspace_script belongs here too: it runs a command read from the
// workspace's paseo.json, which the agent can edit first.
const DAEMON_EXECUTION_TOOLS = [
  "create_terminal",
  "kill_terminal",
  "capture_terminal",
  "send_terminal_keys",
  "start_workspace_script",
];

function createCatalog(allowDaemonExecution: boolean | undefined) {
  const deps: PaseoToolHostDependencies = {
    agentManager: createStub<AgentManager>({}),
    agentStorage: createStub<AgentStorage>({}),
    providerSnapshotManager: createStub<ProviderSnapshotManager>({}),
    terminalManager: createStub<TerminalManager>({}),
    ...(allowDaemonExecution === undefined ? {} : { allowDaemonExecution }),
    logger: pino({ level: "silent" }),
  };
  return createPaseoToolCatalog(deps);
}

describe("paseo tool catalog daemon-execution gating", () => {
  it("omits daemon-execution tools by default", () => {
    const catalog = createCatalog(undefined);

    for (const name of DAEMON_EXECUTION_TOOLS) {
      expect(catalog.getTool(name), `${name} should not be registered`).toBeUndefined();
    }
  });

  it("omits daemon-execution tools when explicitly disabled", () => {
    const catalog = createCatalog(false);

    for (const name of DAEMON_EXECUTION_TOOLS) {
      expect(catalog.getTool(name), `${name} should not be registered`).toBeUndefined();
    }
  });

  it("registers daemon-execution tools when explicitly enabled", () => {
    const catalog = createCatalog(true);

    for (const name of DAEMON_EXECUTION_TOOLS) {
      expect(catalog.getTool(name), `${name} should be registered`).toBeDefined();
    }
  });

  it("keeps read-only listing available regardless", () => {
    // An agent can still describe what is running without being able to drive it.
    for (const name of ["list_terminals", "list_workspace_scripts"]) {
      expect(createCatalog(false).getTool(name), name).toBeDefined();
      expect(createCatalog(true).getTool(name), name).toBeDefined();
    }
  });

  it("does not gate agent spawning, which has its own permission model", () => {
    // Documented boundary: create_agent starts a daemon-owned process too, but
    // spawning agents is the product's purpose and carries a per-agent mode.
    expect(createCatalog(false).getTool("create_agent")).toBeDefined();
  });

  it("leaves non-terminal tools untouched when gating is off", () => {
    const catalog = createCatalog(false);

    expect(catalog.getTool("create_agent")).toBeDefined();
    expect(catalog.getTool("list_workspaces")).toBeDefined();
  });
});
