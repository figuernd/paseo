import { z } from "zod";

import type { CatalogCallResult, HostHandle, HostRegistry } from "../hosts/host-registry.js";
import { requireCandidate, ResolutionError } from "./resolve.js";

export interface ConnectorTool {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<ConnectorToolResult>;
}

export interface ConnectorToolResult {
  text: string;
  structured?: Record<string, unknown>;
  isError?: boolean;
}

interface AgentRow {
  id: string;
  shortId?: string;
  title: string | null;
  status: string;
  cwd: string;
  provider?: unknown;
  updatedAt?: string;
  archivedAt?: string | null;
  requiresAttention?: boolean;
  attentionReason?: string | null;
}

interface WorkspaceRow {
  workspaceId: string;
  cwd: string;
  title: string | null;
  isolation: string;
  kind: string;
}

const HOST_ARG = z
  .string()
  .optional()
  .describe(
    "Which machine, by the name it was given in the connector config. Say it the way the user did.",
  );

function structured<T>(result: CatalogCallResult, key: string): T[] {
  const value = result.structuredContent?.[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

function basename(cwd: string): string {
  const parts = cwd.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

function describeAgent(agent: AgentRow): string {
  return agent.title?.trim() || `untitled agent in ${basename(agent.cwd)}`;
}

/**
 * Voice output is read aloud, so it stays in sentences and stays short. Anything a listener
 * would not sit through belongs in structuredContent, which Claude can consult without
 * speaking it.
 */
function sentence(parts: string[]): string {
  return parts.filter(Boolean).join(" ");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function createConnectorTools(registry: HostRegistry): ConnectorTool[] {
  function requireHost(name: string | undefined): HostHandle {
    const hosts = registry.list();
    if (hosts.length === 0) {
      throw new ResolutionError("No Paseo hosts are configured on this connector.");
    }
    if (!name) {
      if (hosts.length === 1) {
        return hosts[0] as HostHandle;
      }
      throw new ResolutionError(
        `This connector has ${plural(hosts.length, "host")}: ${hosts
          .map((host) => host.name)
          .join(", ")}. Ask which one before retrying.`,
      );
    }
    return requireCandidate(
      name,
      hosts.map((host) => ({
        id: host.name,
        aliases: [host.name, host.status.hostname, host.status.description],
        host,
      })),
      { noun: "host", describe: (candidate) => candidate.id },
    ).host;
  }

  async function agentsOn(host: HostHandle, includeArchived: boolean): Promise<AgentRow[]> {
    const result = await host.callTool("list_agents", {
      includeArchived,
      sinceHours: 24 * 14,
      limit: 200,
    });
    return structured<AgentRow>(result, "agents");
  }

  /** Without an explicit host, the agent name is matched across every host in one pass. */
  async function resolveAgent(
    hostName: string | undefined,
    agentQuery: string,
    includeArchived = false,
  ): Promise<{ host: HostHandle; agent: AgentRow }> {
    const hosts = hostName ? [requireHost(hostName)] : registry.list();
    const rows: Array<{ id: string; aliases: string[]; host: HostHandle; agent: AgentRow }> = [];
    for (const host of hosts) {
      let agents: AgentRow[];
      try {
        agents = await agentsOn(host, includeArchived);
      } catch {
        continue;
      }
      for (const agent of agents) {
        rows.push({
          id: agent.id,
          aliases: [agent.title ?? "", agent.shortId ?? "", basename(agent.cwd)],
          host,
          agent,
        });
      }
    }
    const match = requireCandidate(agentQuery, rows, {
      noun: "agent",
      describe: (row) => `${describeAgent(row.agent)} on ${row.host.name}`,
    });
    return { host: match.host, agent: match.agent };
  }

  const tools: ConnectorTool[] = [
    {
      name: "list_hosts",
      title: "List hosts",
      description:
        "List the machines this connector can reach, whether each one is currently online, and what it is called. Use this when the user asks what machines are available, or when you need a host name for another tool.",
      inputSchema: {},
      async handler() {
        const statuses = registry.statuses();
        if (statuses.length === 0) {
          return { text: "No Paseo hosts are configured on this connector yet." };
        }
        const lines = statuses.map((status) => {
          const state = status.connected
            ? "online"
            : `offline${status.lastError ? ` (${status.lastError})` : ""}`;
          const stale =
            status.connected && !status.supportsToolsCatalog ? ", needs a Paseo update" : "";
          return `${status.name} is ${state}${stale}`;
        });
        return {
          text: `${plural(statuses.length, "host")}: ${lines.join("; ")}.`,
          structured: { hosts: statuses },
        };
      },
    },

    {
      name: "list_workspaces",
      title: "List workspaces",
      description:
        "List the workspaces (checkouts and worktrees) available on a host. Use this to find where work can be started, or to answer what projects are on a machine.",
      inputSchema: { host: HOST_ARG },
      async handler(args) {
        const host = requireHost(args.host as string | undefined);
        const result = await host.callTool("list_workspaces", {});
        const workspaces = structured<WorkspaceRow>(result, "workspaces");
        if (workspaces.length === 0) {
          return { text: `${host.name} has no active workspaces.`, structured: { workspaces } };
        }
        const names = workspaces
          .map((workspace) => workspace.title?.trim() || basename(workspace.cwd))
          .join(", ");
        return {
          text: `${host.name} has ${plural(workspaces.length, "workspace")}: ${names}.`,
          structured: { host: host.name, workspaces },
        };
      },
    },

    {
      name: "list_work",
      title: "List running work",
      description:
        "List agents and what they are doing, across every host or on one host. This is the answer to 'what is running', 'what needs me', or 'how is everything going'. Agents needing attention are called out first.",
      inputSchema: {
        host: HOST_ARG,
        includeFinished: z
          .boolean()
          .optional()
          .describe("Include agents that already finished. Defaults to false."),
      },
      async handler(args) {
        const hosts = args.host ? [requireHost(args.host as string)] : registry.list();
        const includeFinished = args.includeFinished === true;
        const rows: Array<AgentRow & { host: string }> = [];
        const unreachable: string[] = [];
        for (const host of hosts) {
          try {
            const agents = await agentsOn(host, false);
            for (const agent of agents) {
              rows.push({ ...agent, host: host.name });
            }
          } catch (error) {
            unreachable.push(
              `${host.name} (${error instanceof Error ? error.message : String(error)})`,
            );
          }
        }

        const active = rows.filter(
          (row) => includeFinished || (row.status !== "finished" && row.status !== "closed"),
        );
        const attention = active.filter((row) => row.requiresAttention);

        if (active.length === 0) {
          return {
            text: sentence([
              "Nothing is running right now.",
              unreachable.length > 0 ? `Could not reach ${unreachable.join(", ")}.` : "",
            ]),
            structured: { agents: [], unreachable },
          };
        }

        const summary = active
          .map((row) => `${describeAgent(row)} on ${row.host} is ${row.status}`)
          .join("; ");
        const attentionLine =
          attention.length > 0
            ? `${plural(attention.length, "agent")} need${attention.length === 1 ? "s" : ""} you: ${attention
                .map((row) => `${describeAgent(row)} (${row.attentionReason ?? "waiting"})`)
                .join(", ")}.`
            : "";

        return {
          text: sentence([
            attentionLine,
            `${plural(active.length, "agent")}: ${summary}.`,
            unreachable.length > 0 ? `Could not reach ${unreachable.join(", ")}.` : "",
          ]),
          structured: { agents: active, unreachable },
        };
      },
    },

    {
      name: "start_work",
      title: "Start work",
      description:
        "Start a new agent on a host to carry out a task. This is the main tool: the user describes work out loud and you hand it to an agent. Pass their instruction as `task`, expanded into a complete brief the agent can act on without asking follow-ups. Returns as soon as the agent is running; it keeps working in the background.",
      inputSchema: {
        host: HOST_ARG,
        task: z
          .string()
          .min(1)
          .describe(
            "The full instruction for the agent, written as you would brief a capable engineer who cannot ask you questions.",
          ),
        workspace: z
          .string()
          .optional()
          .describe(
            "Which workspace to work in, by project or directory name. Omit only if the user did not indicate one and the host has a single obvious workspace.",
          ),
        title: z
          .string()
          .max(60)
          .optional()
          .describe("Short title for the agent (<= 60 chars). Generated from the task if omitted."),
        provider: z
          .string()
          .optional()
          .describe(
            "Provider and model, for example claude/opus or codex/gpt-5.4. Omit to use the host default.",
          ),
      },
      async handler(args) {
        const host = requireHost(args.host as string | undefined);
        const task = String(args.task ?? "").trim();
        if (!task) {
          throw new ResolutionError("start_work needs a task to hand to the agent.");
        }

        let workspaceId: string | undefined;
        if (args.workspace) {
          const listed = await host.callTool("list_workspaces", {});
          const workspaces = structured<WorkspaceRow>(listed, "workspaces");
          const match = requireCandidate(
            String(args.workspace),
            workspaces.map((workspace) => ({
              id: workspace.workspaceId,
              aliases: [workspace.title, basename(workspace.cwd), workspace.cwd],
              workspace,
            })),
            {
              noun: "workspace",
              describe: (row) => row.workspace.title || basename(row.workspace.cwd),
            },
          );
          workspaceId = match.workspace.workspaceId;
        }

        const provider = (args.provider as string | undefined) ?? (await defaultProvider(host));
        const title = toTitle((args.title as string | undefined) ?? task);

        const result = await host.callTool("create_agent", {
          title,
          provider,
          initialPrompt: task,
          ...(workspaceId ? { workspaceId } : {}),
          // A voice turn cannot block on an agent run, and the user is not watching a screen.
          background: true,
          notifyOnFinish: true,
        });

        const agentId = String(result.structuredContent?.agentId ?? "");
        const cwd = String(result.structuredContent?.cwd ?? "");
        return {
          text: `Started "${title}" on ${host.name}${cwd ? ` in ${basename(cwd)}` : ""}. It is running in the background.`,
          structured: { host: host.name, agentId, ...result.structuredContent },
        };
      },
    },

    {
      name: "check_work",
      title: "Check on work",
      description:
        "Report what one agent has been doing and whether it is blocked, finished, or still working. Use when the user asks about a specific piece of work by name.",
      inputSchema: {
        host: HOST_ARG,
        agent: z
          .string()
          .describe("The agent, by its title or short id, as the user refers to it."),
        detail: z
          .boolean()
          .optional()
          .describe("Include the recent activity transcript. Defaults to a spoken summary only."),
      },
      async handler(args) {
        const { host, agent } = await resolveAgent(
          args.host as string | undefined,
          String(args.agent),
        );
        const activity = await host.callTool("get_agent_activity", {
          agentId: agent.id,
          limit: 20,
        });
        const content = String(activity.structuredContent?.content ?? "").trim();
        const headline = `${describeAgent(agent)} on ${host.name} is ${agent.status}${
          agent.requiresAttention ? ` and needs you (${agent.attentionReason ?? "waiting"})` : ""
        }.`;
        return {
          text:
            args.detail === true && content
              ? `${headline}\n\n${content}`
              : sentence([headline, content ? summarizeActivity(content) : ""]),
          structured: {
            host: host.name,
            agentId: agent.id,
            status: agent.status,
            activity: content,
          },
        };
      },
    },

    {
      name: "send_message",
      title: "Send a message to an agent",
      description:
        "Send a follow-up instruction to an agent that is already running. Use for course corrections and answers to questions the agent asked.",
      inputSchema: {
        host: HOST_ARG,
        agent: z.string().describe("The agent, by its title or short id."),
        message: z.string().min(1).describe("What to tell the agent."),
      },
      async handler(args) {
        const { host, agent } = await resolveAgent(
          args.host as string | undefined,
          String(args.agent),
        );
        await host.callTool("send_agent_prompt", {
          agentId: agent.id,
          prompt: String(args.message),
          background: true,
        });
        return {
          text: `Passed that along to ${describeAgent(agent)} on ${host.name}.`,
          structured: { host: host.name, agentId: agent.id },
        };
      },
    },

    {
      name: "list_permissions",
      title: "List pending approvals",
      description:
        "List the permission requests agents are waiting on across hosts. Read these out so the user can approve or deny by voice.",
      inputSchema: { host: HOST_ARG },
      async handler(args) {
        const hosts = args.host ? [requireHost(args.host as string)] : registry.list();
        const pending: Array<Record<string, unknown>> = [];
        for (const host of hosts) {
          try {
            const result = await host.callTool("list_pending_permissions", {});
            for (const entry of structured<Record<string, unknown>>(result, "permissions")) {
              pending.push({ ...entry, host: host.name });
            }
          } catch {
            continue;
          }
        }
        if (pending.length === 0) {
          return { text: "Nothing is waiting on your approval.", structured: { permissions: [] } };
        }
        const lines = pending.map((entry) => {
          const request = entry.request as { title?: string; toolName?: string } | undefined;
          return `${request?.title ?? request?.toolName ?? "a request"} on ${String(entry.host)}`;
        });
        return {
          text: `${plural(pending.length, "approval")} waiting: ${lines.join(", ")}.`,
          structured: { permissions: pending },
        };
      },
    },

    {
      name: "answer_permission",
      title: "Answer a pending approval",
      description:
        "Approve or deny a permission request an agent is blocked on. Call list_permissions first unless you already know which request the user means.",
      inputSchema: {
        host: HOST_ARG,
        agent: z.string().describe("The agent waiting on the approval, by title or short id."),
        decision: z.enum(["allow", "deny"]).describe("What the user decided."),
        message: z
          .string()
          .optional()
          .describe("Optional note to the agent, most useful when denying."),
      },
      async handler(args) {
        const { host, agent } = await resolveAgent(
          args.host as string | undefined,
          String(args.agent),
        );
        const listed = await host.callTool("list_pending_permissions", {});
        const entries = structured<{
          agentId: string;
          request: { requestId?: string; id?: string };
        }>(listed, "permissions");
        const entry = entries.find((candidate) => candidate.agentId === agent.id);
        if (!entry) {
          return {
            text: `${describeAgent(agent)} on ${host.name} is not waiting on an approval right now.`,
            isError: true,
          };
        }
        const requestId = entry.request.requestId ?? entry.request.id;
        if (!requestId) {
          return {
            text: `That approval request is missing an id; it may have just resolved.`,
            isError: true,
          };
        }
        const decision = String(args.decision);
        await host.callTool("respond_to_permission", {
          agentId: agent.id,
          requestId,
          response:
            decision === "allow"
              ? { behavior: "allow" }
              : { behavior: "deny", ...(args.message ? { message: String(args.message) } : {}) },
        });
        return {
          text: `${decision === "allow" ? "Approved" : "Denied"} for ${describeAgent(agent)} on ${host.name}.`,
          structured: { host: host.name, agentId: agent.id, decision },
        };
      },
    },

    {
      name: "stop_work",
      title: "Stop an agent",
      description:
        "Interrupt what an agent is currently doing without deleting it. The agent stays available for follow-up.",
      inputSchema: {
        host: HOST_ARG,
        agent: z.string().describe("The agent, by its title or short id."),
      },
      async handler(args) {
        const { host, agent } = await resolveAgent(
          args.host as string | undefined,
          String(args.agent),
        );
        await host.callTool("cancel_agent", { agentId: agent.id });
        return {
          text: `Stopped ${describeAgent(agent)} on ${host.name}.`,
          structured: { host: host.name, agentId: agent.id },
        };
      },
    },

    {
      name: "archive_work",
      title: "Archive an agent",
      description:
        "Archive an agent once its work is done. Interrupts it if it is still running and removes it from the active list.",
      inputSchema: {
        host: HOST_ARG,
        agent: z.string().describe("The agent, by its title or short id."),
      },
      async handler(args) {
        const { host, agent } = await resolveAgent(
          args.host as string | undefined,
          String(args.agent),
        );
        await host.callTool("archive_agent", { agentId: agent.id });
        return {
          text: `Archived ${describeAgent(agent)} on ${host.name}.`,
          structured: { host: host.name, agentId: agent.id },
        };
      },
    },

    {
      name: "list_paseo_tools",
      title: "List every Paseo tool on a host",
      description:
        "List the full Paseo tool catalog a host exposes, with argument schemas. Use this only when the user asks for something the other tools here do not cover — schedules, terminals, worktrees, workspace scripts, providers — then call run_paseo_tool with what you find.",
      inputSchema: {
        host: HOST_ARG,
        filter: z
          .string()
          .optional()
          .describe("Only return tools whose name or description contains this."),
      },
      async handler(args) {
        const host = requireHost(args.host as string | undefined);
        const all = await host.listTools();
        const filter = String(args.filter ?? "")
          .trim()
          .toLowerCase();
        const matched = filter
          ? all.filter(
              (tool) =>
                tool.name.toLowerCase().includes(filter) ||
                tool.description.toLowerCase().includes(filter),
            )
          : all;
        return {
          text: `${host.name} exposes ${plural(matched.length, "tool")}: ${matched
            .map((tool) => tool.name)
            .join(", ")}.`,
          structured: { host: host.name, tools: matched },
        };
      },
    },

    {
      name: "run_paseo_tool",
      title: "Run a Paseo tool directly",
      description:
        "Call any tool from a host's Paseo catalog by name. The escape hatch for anything the curated tools above do not cover. Call list_paseo_tools first to get the exact name and argument schema — do not guess arguments.",
      inputSchema: {
        host: HOST_ARG,
        tool: z.string().min(1).describe("Exact tool name from list_paseo_tools."),
        arguments: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Arguments matching that tool's schema."),
      },
      async handler(args) {
        const host = requireHost(args.host as string | undefined);
        const toolName = String(args.tool);
        const result = await host.callTool(
          toolName,
          (args.arguments as Record<string, unknown> | undefined) ?? {},
        );
        const text =
          result.content
            .map((item) => item.text)
            .filter((value): value is string => typeof value === "string" && value.length > 0)
            .join("\n") || `${toolName} completed on ${host.name}.`;
        return {
          text,
          ...(result.structuredContent ? { structured: result.structuredContent } : {}),
          ...(result.isError !== undefined ? { isError: result.isError } : {}),
        };
      },
    },
  ];

  return tools;
}

/**
 * The catalog requires an explicit provider/model. Asking the user to say "claude slash opus" out
 * loud is not acceptable, so fall back to whatever the host reports as available.
 */
async function defaultProvider(host: HostHandle): Promise<string> {
  const result = await host.callTool("list_providers", {});
  const providers = structured<{ id?: string; available?: boolean; defaultModel?: string | null }>(
    result,
    "providers",
  );
  const usable = providers.find((provider) => provider.available !== false && provider.id);
  if (!usable?.id) {
    throw new ResolutionError(
      `${host.name} has no available agent provider configured. Set one up in Paseo before starting work.`,
    );
  }
  return usable.defaultModel ? `${usable.id}/${usable.defaultModel}` : usable.id;
}

/**
 * The catalog caps titles at 60 characters. The title is spoken back in the confirmation and shown
 * in every list afterwards, so cut it at a word boundary — "migrate everyone to to" is what a
 * naive slice produces.
 */
const TITLE_LIMIT = 60;

export function toTitle(source: string): string {
  const collapsed = source.replace(/\s+/g, " ").trim();
  const firstSentence = collapsed.split(/(?<=[.!?])\s/)[0] ?? collapsed;
  const candidate = firstSentence.length <= TITLE_LIMIT ? firstSentence : collapsed;
  if (candidate.length <= TITLE_LIMIT) {
    return candidate.replace(/[.]$/, "");
  }
  const cut = candidate.slice(0, TITLE_LIMIT + 1);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : candidate.slice(0, TITLE_LIMIT)).replace(
    /[,;:.]$/,
    "",
  );
}

/** Activity transcripts run to thousands of characters; a voice turn gets the tail. */
function summarizeActivity(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= 400) {
    return trimmed;
  }
  return `Most recently: ${trimmed.slice(-400).trimStart()}`;
}
