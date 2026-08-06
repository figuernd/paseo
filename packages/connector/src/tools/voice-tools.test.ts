import { describe, expect, test } from "vitest";

import type {
  CatalogCallResult,
  HostHandle,
  HostRegistry,
  HostStatus,
} from "../hosts/host-registry.js";
import { createConnectorTools, toTitle, type ConnectorTool } from "./voice-tools.js";

/**
 * A stand-in for one daemon's tool catalog. It answers the same tool names with the same payload
 * shapes the real catalog returns, and records what it was called with, which is what these tests
 * are actually about: the connector resolves spoken references and forwards the right arguments.
 */
class FakeHost implements HostHandle {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];

  constructor(
    readonly name: string,
    private readonly state: {
      agents?: Array<Record<string, unknown>>;
      workspaces?: Array<Record<string, unknown>>;
      permissions?: Array<Record<string, unknown>>;
      providers?: Array<Record<string, unknown>>;
      offline?: boolean;
    } = {},
  ) {}

  get status(): HostStatus {
    return {
      name: this.name,
      connected: !this.state.offline,
      transport: "direct",
      hostname: `${this.name}.local`,
      serverId: `srv-${this.name}`,
      version: "0.3.0",
      supportsToolsCatalog: true,
      lastError: null,
    };
  }

  async listTools() {
    return [
      { name: "create_schedule", description: "Create a cron schedule that starts a new agent." },
      { name: "list_terminals", description: "List terminal sessions." },
    ];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CatalogCallResult> {
    if (this.state.offline) {
      throw new Error(`${this.name} is unreachable`);
    }
    this.calls.push({ name, args });
    switch (name) {
      case "list_agents":
        return { content: [], structuredContent: { agents: this.state.agents ?? [] } };
      case "list_workspaces":
        return { content: [], structuredContent: { workspaces: this.state.workspaces ?? [] } };
      case "list_pending_permissions":
        return { content: [], structuredContent: { permissions: this.state.permissions ?? [] } };
      case "list_providers":
        return { content: [], structuredContent: { providers: this.state.providers ?? [] } };
      case "create_agent":
        return {
          content: [],
          structuredContent: { agentId: "agent-new", cwd: "/repos/paseo", status: "running" },
        };
      case "get_agent_activity":
        return {
          content: [],
          structuredContent: { content: "Ran the test suite. 3 failures left." },
        };
      case "create_schedule":
        return {
          content: [{ type: "text", text: "Schedule created." }],
          structuredContent: { id: "sch-1" },
        };
      default:
        return { content: [], structuredContent: { success: true } };
    }
  }
}

function registryOf(...hosts: FakeHost[]): HostRegistry {
  return {
    list: () => hosts,
    get: (name) => hosts.find((host) => host.name.toLowerCase() === name.toLowerCase()),
    statuses: () => hosts.map((host) => host.status),
    warmUp: async () => {},
    close: async () => {},
  };
}

function toolNamed(registry: HostRegistry, name: string): ConnectorTool {
  const tool = createConnectorTools(registry).find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`No connector tool named ${name}`);
  }
  return tool;
}

const runningAgent = {
  id: "agt_01authrefactor",
  shortId: "a1b2",
  title: "Auth refactor",
  status: "running",
  cwd: "/repos/paseo",
  requiresAttention: false,
};

const blockedAgent = {
  id: "agt_02website",
  shortId: "c3d4",
  title: "Website copy",
  status: "waiting",
  cwd: "/repos/website",
  requiresAttention: true,
  attentionReason: "permission",
};

describe("list_hosts", () => {
  test("names each host and whether it is online", async () => {
    const registry = registryOf(
      new FakeHost("laptop"),
      new FakeHost("mac mini", { offline: true }),
    );
    const result = await toolNamed(registry, "list_hosts").handler({});
    expect(result.text).toBe("2 hosts: laptop is online; mac mini is offline.");
  });

  test("says so when nothing is configured", async () => {
    const result = await toolNamed(registryOf(), "list_hosts").handler({});
    expect(result.text).toBe("No Paseo hosts are configured on this connector yet.");
  });
});

describe("list_work", () => {
  test("leads with the agents that need the user", async () => {
    const registry = registryOf(
      new FakeHost("laptop", { agents: [runningAgent] }),
      new FakeHost("mac mini", { agents: [blockedAgent] }),
    );
    const result = await toolNamed(registry, "list_work").handler({});
    expect(result.text).toBe(
      "1 agent needs you: Website copy (permission). 2 agents: Auth refactor on laptop is running; Website copy on mac mini is waiting.",
    );
  });

  test("reports an unreachable host instead of pretending it is idle", async () => {
    const registry = registryOf(
      new FakeHost("laptop", { agents: [runningAgent] }),
      new FakeHost("vps", { offline: true }),
    );
    const result = await toolNamed(registry, "list_work").handler({});
    expect(result.text).toContain("Could not reach vps");
    expect(result.structured?.unreachable).toEqual(["vps (vps is unreachable)"]);
  });

  test("says nothing is running when every agent has finished", async () => {
    const registry = registryOf(
      new FakeHost("laptop", { agents: [{ ...runningAgent, status: "finished" }] }),
    );
    const result = await toolNamed(registry, "list_work").handler({});
    expect(result.text).toBe("Nothing is running right now.");
  });
});

describe("start_work", () => {
  test("creates a background agent in the workspace the user named", async () => {
    const host = new FakeHost("laptop", {
      workspaces: [
        {
          workspaceId: "ws-1",
          cwd: "/repos/paseo",
          title: "paseo",
          isolation: "local",
          kind: "directory",
        },
        {
          workspaceId: "ws-2",
          cwd: "/repos/website",
          title: null,
          isolation: "local",
          kind: "directory",
        },
      ],
      providers: [{ id: "claude", available: true, defaultModel: "opus" }],
    });
    const result = await toolNamed(registryOf(host), "start_work").handler({
      task: "Rip out the legacy session cookie and migrate everyone to tokens.",
      workspace: "website",
    });

    const create = host.calls.find((call) => call.name === "create_agent");
    expect(create?.args).toEqual({
      title: "Rip out the legacy session cookie and migrate everyone to",
      provider: "claude/opus",
      initialPrompt: "Rip out the legacy session cookie and migrate everyone to tokens.",
      workspaceId: "ws-2",
      background: true,
      notifyOnFinish: true,
    });
    expect(result.text).toBe(
      'Started "Rip out the legacy session cookie and migrate everyone to" on laptop in paseo. It is running in the background.',
    );
  });

  test("refuses to pick between hosts when the user did not name one", async () => {
    const registry = registryOf(new FakeHost("laptop"), new FakeHost("mac mini"));
    await expect(toolNamed(registry, "start_work").handler({ task: "do a thing" })).rejects.toThrow(
      /This connector has 2 hosts: laptop, mac mini\. Ask which one/,
    );
  });

  test("uses the only host without being told which one", async () => {
    const host = new FakeHost("laptop", { providers: [{ id: "codex", available: true }] });
    await toolNamed(registryOf(host), "start_work").handler({ task: "run the tests" });
    expect(host.calls.find((call) => call.name === "create_agent")?.args.provider).toBe("codex");
  });

  test("refuses to start when the host has no usable provider", async () => {
    const host = new FakeHost("laptop", { providers: [{ id: "claude", available: false }] });
    await expect(toolNamed(registryOf(host), "start_work").handler({ task: "x" })).rejects.toThrow(
      /no available agent provider/,
    );
  });

  test("asks which workspace when the name matches two", async () => {
    const host = new FakeHost("laptop", {
      workspaces: [
        {
          workspaceId: "ws-1",
          cwd: "/repos/api-v1",
          title: "api v1",
          isolation: "local",
          kind: "directory",
        },
        {
          workspaceId: "ws-2",
          cwd: "/repos/api-v2",
          title: "api v2",
          isolation: "local",
          kind: "directory",
        },
      ],
      providers: [{ id: "claude", available: true }],
    });
    await expect(
      toolNamed(registryOf(host), "start_work").handler({ task: "x", workspace: "api" }),
    ).rejects.toThrow(/matches more than one workspace: api v1, api v2/);
  });
});

describe("toTitle", () => {
  test("keeps a short task as-is, minus the full stop", () => {
    expect(toTitle("Fix the flaky login test.")).toBe("Fix the flaky login test");
  });

  test("prefers the first sentence when the task is several sentences", () => {
    expect(toTitle("Update the changelog. Then tag the release and push it upstream.")).toBe(
      "Update the changelog",
    );
  });

  test("cuts at a word boundary rather than mid-word", () => {
    const title = toTitle(
      "Rip out the legacy session cookie and migrate everyone to tokens without downtime",
    );
    expect(title).toBe("Rip out the legacy session cookie and migrate everyone to");
    expect(title.length).toBeLessThanOrEqual(60);
  });

  test("falls back to a hard cut when there is no word boundary to use", () => {
    expect(toTitle("x".repeat(80))).toBe("x".repeat(60));
  });

  test("collapses the whitespace that dictation leaves behind", () => {
    expect(toTitle("  Fix   the   build  ")).toBe("Fix the build");
  });
});

describe("agent-targeted tools", () => {
  test("check_work finds an agent by title without being told the host", async () => {
    const laptop = new FakeHost("laptop", { agents: [runningAgent] });
    const mini = new FakeHost("mac mini", { agents: [blockedAgent] });
    const result = await toolNamed(registryOf(laptop, mini), "check_work").handler({
      agent: "website copy",
    });
    expect(result.text).toBe(
      "Website copy on mac mini is waiting and needs you (permission). Ran the test suite. 3 failures left.",
    );
  });

  test("send_message forwards the follow-up to the resolved agent", async () => {
    const host = new FakeHost("laptop", { agents: [runningAgent] });
    await toolNamed(registryOf(host), "send_message").handler({
      agent: "auth refactor",
      message: "Skip the migration for now.",
    });
    expect(host.calls.find((call) => call.name === "send_agent_prompt")?.args).toEqual({
      agentId: "agt_01authrefactor",
      prompt: "Skip the migration for now.",
      background: true,
    });
  });

  test("stop_work cancels the run without archiving it", async () => {
    const host = new FakeHost("laptop", { agents: [runningAgent] });
    const result = await toolNamed(registryOf(host), "stop_work").handler({ agent: "auth" });
    expect(host.calls.at(-1)).toEqual({
      name: "cancel_agent",
      args: { agentId: "agt_01authrefactor" },
    });
    expect(result.text).toBe("Stopped Auth refactor on laptop.");
  });

  test("archive_work archives the resolved agent", async () => {
    const host = new FakeHost("laptop", { agents: [runningAgent] });
    await toolNamed(registryOf(host), "archive_work").handler({ agent: "a1b2" });
    expect(host.calls.at(-1)).toEqual({
      name: "archive_agent",
      args: { agentId: "agt_01authrefactor" },
    });
  });

  test("an unknown agent name lists the real ones", async () => {
    const host = new FakeHost("laptop", { agents: [runningAgent] });
    await expect(
      toolNamed(registryOf(host), "check_work").handler({ agent: "database migration" }),
    ).rejects.toThrow(
      /No agent matches "database migration"\. Available: Auth refactor on laptop\./,
    );
  });
});

describe("permissions", () => {
  const permission = {
    agentId: "agt_02website",
    status: "waiting",
    request: { requestId: "req-9", title: "Run `rm -rf build`" },
  };

  test("list_permissions reads back what is waiting and where", async () => {
    const registry = registryOf(new FakeHost("mac mini", { permissions: [permission] }));
    const result = await toolNamed(registry, "list_permissions").handler({});
    expect(result.text).toBe("1 approval waiting: Run `rm -rf build` on mac mini.");
  });

  test("answer_permission sends an allow for the matching request", async () => {
    const host = new FakeHost("mac mini", { agents: [blockedAgent], permissions: [permission] });
    const result = await toolNamed(registryOf(host), "answer_permission").handler({
      agent: "website copy",
      decision: "allow",
    });
    expect(host.calls.at(-1)).toEqual({
      name: "respond_to_permission",
      args: { agentId: "agt_02website", requestId: "req-9", response: { behavior: "allow" } },
    });
    expect(result.text).toBe("Approved for Website copy on mac mini.");
  });

  test("a denial carries the user's reason back to the agent", async () => {
    const host = new FakeHost("mac mini", { agents: [blockedAgent], permissions: [permission] });
    await toolNamed(registryOf(host), "answer_permission").handler({
      agent: "website copy",
      decision: "deny",
      message: "Not that directory.",
    });
    expect(host.calls.at(-1)?.args.response).toEqual({
      behavior: "deny",
      message: "Not that directory.",
    });
  });

  test("answering an agent that is not blocked reports it instead of guessing", async () => {
    const host = new FakeHost("laptop", { agents: [runningAgent], permissions: [] });
    const result = await toolNamed(registryOf(host), "answer_permission").handler({
      agent: "auth refactor",
      decision: "allow",
    });
    expect(result).toEqual({
      text: "Auth refactor on laptop is not waiting on an approval right now.",
      isError: true,
    });
  });
});

describe("escape hatch", () => {
  test("list_paseo_tools filters the host catalog", async () => {
    const registry = registryOf(new FakeHost("laptop"));
    const result = await toolNamed(registry, "list_paseo_tools").handler({ filter: "schedule" });
    expect(result.text).toBe("laptop exposes 1 tool: create_schedule.");
  });

  test("run_paseo_tool forwards arguments verbatim and speaks the tool's own output", async () => {
    const host = new FakeHost("laptop");
    const result = await toolNamed(registryOf(host), "run_paseo_tool").handler({
      tool: "create_schedule",
      arguments: { cron: "0 9 * * 1", prompt: "Weekly dependency review" },
    });
    expect(host.calls.at(-1)).toEqual({
      name: "create_schedule",
      args: { cron: "0 9 * * 1", prompt: "Weekly dependency review" },
    });
    expect(result.text).toBe("Schedule created.");
    expect(result.structured).toEqual({ id: "sch-1" });
  });
});
