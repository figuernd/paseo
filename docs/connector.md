# Claude connector

The connector is a bridge that lets Claude — including voice mode in the Claude app — start and steer agents across your Paseo hosts. You add it once as a custom connector in Claude, and every host it reaches becomes available by name: "start an agent on the mac mini in the paseo repo and have it fix the flaky login test."

It lives in `packages/connector` and ships as `@getpaseo/connector`.

## Why it is a separate process

Claude can only reach a remote MCP server over public HTTPS from Anthropic's IP ranges. A daemon is not that: it binds loopback by default, and the machines you care about are usually behind NAT. The connector is the one process you expose, and it reaches your daemons the same way the mobile app does — direct TCP where that works, and the relay's end-to-end encrypted transport where it does not.

That also solves the multi-host problem. One connector holds every host, so Claude gets one connector and every tool takes a host argument, instead of one connector per machine with colliding tool names.

Run it wherever it can hold a public name: an always-on box, a VPS, or behind a tunnel. It holds relay keys for the daemons it reaches, so treat it as a trusted client, not as infrastructure.

## Topology

```
Claude (voice or text)
   │  HTTPS + OAuth 2.1, Streamable HTTP MCP
   ▼
Connector ──── direct TCP ────► daemon on this network
   │
   └───── relay (E2EE) ───────► daemon behind NAT
```

The connector never talks to a daemon's `/mcp/agents` HTTP route. It uses `tools.catalog.list` and `tools.catalog.call` on the session WebSocket, so the direct and relay paths are the same code. Hosts older than the RPC are reported as needing an update rather than silently failing; the capability is gated on `server_info.features.toolsCatalogRpc`.

## Tool surface

Twelve tools, in two groups.

The curated ones are written for speech: `list_hosts`, `list_workspaces`, `list_work`, `start_work`, `check_work`, `send_message`, `list_permissions`, `answer_permission`, `stop_work`, `archive_work`. They take names, not identifiers, and answer in sentences short enough to be read aloud. Everything a listener would not sit through goes in `structuredContent`, which Claude can consult without speaking it.

The escape hatch is `list_paseo_tools` plus `run_paseo_tool`, which reach the host's full catalog — schedules, terminals, worktrees, workspace scripts, providers. Curated tools delegate to that same catalog, so there is one code path to the daemon and the escape hatch is not a second-class one.

### Resolution

Speech does not produce identifiers. Every reference is matched against what exists, in tiers: exact id, exact alias, id prefix, alias prefix, substring, then all-words-present. The first tier with a hit wins, so an exact name never loses to something that merely contains it.

A query that matches two things is an error naming both, not a guess. These tools start agents; asking is cheaper than being wrong. The same rule covers what was never said: `start_work` resolves a workspace explicitly every time, using the sole workspace when a host has exactly one and asking otherwise. Leaving `workspaceId` off a top-level `create_agent` makes the daemon open a workspace at its own process directory, which is almost never where the user meant.

Two daemon shapes are easy to get wrong from the outside, and both fail quietly rather than loudly. Agent lifecycle is `initializing | idle | running | error | closed` — there is no "finished"; a completed agent returns to `idle` and raises `requiresAttention` with `attentionReason`. And `list_providers` reports `enabled` plus a `status` of `available`, never an availability boolean or a default model: the model list, including which is default, only comes from `list_models`, and `create_agent` rejects a bare provider id.

## Authorization

The connector is its own OAuth 2.1 authorization server, because Claude requires one and there is nothing else to delegate to.

| Endpoint                                      | What it does                                         |
| --------------------------------------------- | ---------------------------------------------------- |
| `/.well-known/oauth-protected-resource[/mcp]` | RFC 9728 — points Claude at the authorization server |
| `/.well-known/oauth-authorization-server`     | RFC 8414 — endpoints and supported grants            |
| `/oauth/register`                             | RFC 7591 dynamic client registration                 |
| `/oauth/authorize` → `/oauth/approve`         | Approval page gated on the pairing code              |
| `/oauth/token`                                | PKCE code exchange and refresh                       |

Registration is open. That is safe only because a registered client still cannot get a token without the pairing code, which is the single secret standing between the public internet and your agents.

Two things follow from that, and both are enforced rather than advised. The code must be at least 24 characters with real variety, checked at startup, because a code someone invented is the weakest part of this design. And failed approvals are rate limited with exponential backoff, keyed on the source address rather than `client_id` — registration is open, so an attacker can mint a fresh client id per guess and a client-keyed limiter would never fire. A looser global counter sits behind it so a distributed attack still slows to a crawl without letting one attacker lock you out of your own connector.

Access tokens live an hour, refresh tokens rotate on use, and both are stored as SHA-256 hashes next to your config at `connector-oauth.json` — a leaked state file yields no live tokens. Tokens are bound to the resource identifier (`publicUrl` + `/mcp`), so `publicUrl` must be exactly the origin Claude calls. A mismatch fails audience validation rather than degrading.

## Trust boundary

Anyone holding the pairing code can start agents on every configured host, with whatever authority those daemons have. The connector adds no sandbox of its own — it is an authenticated remote control for machines that already trust their local clients. [SECURITY.md](../SECURITY.md) covers where that sits relative to the daemon and relay threat models.

## Configuration

`$PASEO_HOME/connector.json`, or `PASEO_CONNECTOR_CONFIG`:

```json
{
  "version": 1,
  "listen": "127.0.0.1:6790",
  "publicUrl": "https://paseo.example.com",
  "pairingCode": "generate-something-long",
  "hosts": [
    { "name": "laptop", "endpoint": "tcp://127.0.0.1:6767" },
    { "name": "mac mini", "offer": "https://app.paseo.sh/#offer=..." },
    { "name": "vps", "endpoint": "tcp://10.0.0.5:6767?ssl=true", "password": "..." }
  ]
}
```

Each host takes exactly one of `endpoint` or `offer`. Endpoints are the strings `paseo --host` already accepts. An offer is the pairing URL Paseo renders as a QR code; use it for anything you cannot reach directly, since it carries the daemon's public key and gets you the encrypted relay path.

Host names are what you will say out loud, so pick names you would actually use. Duplicates are rejected — an ambiguous host name is an ambiguous voice command.

`GET /health` answers liveness and nothing else. It is unauthenticated and public, so it must never describe the hosts behind it; use `list_hosts` through an authenticated session for that.

`PASEO_CONNECTOR_LISTEN`, `PASEO_CONNECTOR_PUBLIC_URL`, and `PASEO_CONNECTOR_PAIRING_CODE` override the file.

## Running it

```bash
npx @getpaseo/connector          # reads $PASEO_HOME/connector.json
```

Put TLS in front of it and point `publicUrl` at the result. Then in Claude: **Settings → Connectors → Add custom connector**, URL `https://your-host/mcp`. Claude registers itself, opens the approval page, and asks for the pairing code once.

Voice mode gained connector support in July 2026 and is available on paid plans; free accounts get one connector on Haiku.

## Testing

`packages/connector/src/oauth/oauth.test.ts` runs the real authorization flow over real HTTP, including the attacks worth caring about: unregistered redirect URIs, wrong PKCE verifiers, replayed codes, spent refresh tokens, and a missing pairing code.

`packages/connector/src/connector.e2e.test.ts` drives the connector with a real MCP client through that flow, and `packages/server/src/server/session/tools/tools-catalog.e2e.test.ts` covers the other half of the path against a real daemon and its real catalog. The two meet at `HostHandle.callTool`.
