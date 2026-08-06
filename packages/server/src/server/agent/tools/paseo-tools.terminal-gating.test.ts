import { describe, expect, it } from "vitest";
import pino from "pino";

import { createStub } from "../../test-utils/class-mocks.js";
import { createPaseoToolCatalog, type PaseoToolHostDependencies } from "./paseo-tools.js";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import type { ProviderSnapshotManager } from "../../provider-snapshot-manager.js";
import type { TerminalManager } from "../../terminal/terminal-manager.js";

// Tools that spawn a PTY or write into one. The PTY is a child of the daemon,
// so it does not inherit the calling agent's sandbox.
const PTY_TOOLS = ["create_terminal", "kill_terminal", "capture_terminal", "send_terminal_keys"];

function createCatalog(allowTerminalTools: boolean | undefined) {
  const deps: PaseoToolHostDependencies = {
    agentManager: createStub<AgentManager>({}),
    agentStorage: createStub<AgentStorage>({}),
    providerSnapshotManager: createStub<ProviderSnapshotManager>({}),
    terminalManager: createStub<TerminalManager>({}),
    ...(allowTerminalTools === undefined ? {} : { allowTerminalTools }),
    logger: pino({ level: "silent" }),
  };
  return createPaseoToolCatalog(deps);
}

describe("paseo tool catalog terminal gating", () => {
  it("omits PTY tools by default", () => {
    const catalog = createCatalog(undefined);

    for (const name of PTY_TOOLS) {
      expect(catalog.getTool(name), `${name} should not be registered`).toBeUndefined();
    }
  });

  it("omits PTY tools when explicitly disabled", () => {
    const catalog = createCatalog(false);

    for (const name of PTY_TOOLS) {
      expect(catalog.getTool(name), `${name} should not be registered`).toBeUndefined();
    }
  });

  it("registers PTY tools when explicitly enabled", () => {
    const catalog = createCatalog(true);

    for (const name of PTY_TOOLS) {
      expect(catalog.getTool(name), `${name} should be registered`).toBeDefined();
    }
  });

  it("keeps read-only terminal listing available regardless", () => {
    // An agent can still describe what is running without being able to drive it.
    expect(createCatalog(false).getTool("list_terminals")).toBeDefined();
    expect(createCatalog(true).getTool("list_terminals")).toBeDefined();
  });

  it("leaves non-terminal tools untouched when gating is off", () => {
    const catalog = createCatalog(false);

    expect(catalog.getTool("create_agent")).toBeDefined();
    expect(catalog.getTool("list_workspaces")).toBeDefined();
  });
});
