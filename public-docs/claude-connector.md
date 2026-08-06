---
title: Claude connector
description: Add Paseo to Claude as a custom connector and direct agents across your machines by voice.
nav: Claude connector
order: 34
category: Orchestration
---

# Claude connector

Talk to Claude, and Claude puts agents to work on your machines. "Start an agent on the mac mini in the paseo repo to fix the flaky login test." "What's running?" "Approve that." It works in Claude's voice mode, and in ordinary chat.

The connector is a small process you run once. It reaches every Paseo host you configure and gives Claude a single place to talk to all of them.

## What you need

- A machine to run the connector on that Claude can reach over HTTPS — an always-on box, a VPS, or anything you can put a tunnel in front of. Your dev machines do not need to be reachable; the connector reaches them.
- A paid Claude plan for voice mode with connectors. Free accounts get one connector on Haiku.

## Set it up

**1. Write the config** at `~/.paseo/connector.json`:

```json
{
  "version": 1,
  "publicUrl": "https://paseo.example.com",
  "pairingCode": "generate-something-long-and-random",
  "hosts": [
    { "name": "laptop", "endpoint": "tcp://127.0.0.1:6767" },
    { "name": "mac mini", "offer": "https://app.paseo.sh/#offer=..." }
  ]
}
```

Give each host exactly one of:

- `endpoint` — the same address you would pass to `paseo --host`, for machines the connector can reach directly.
- `offer` — a pairing URL, for machines it cannot. Get one from **Settings → your host → Pair a device** and copy the link behind the QR code. This reaches the host over Paseo's encrypted relay, so nothing needs an open port.

Name hosts the way you will say them out loud. "mac mini" is a better name than `host-2`.

**2. Run it:**

```bash
npx @getpaseo/connector
```

It listens on `127.0.0.1:6790` by default. Put TLS in front of it — a reverse proxy or a tunnel — and make `publicUrl` exactly the address that lands there.

**3. Add it to Claude.** Go to **Settings → Connectors → Add custom connector** and enter `https://your-address/mcp`. Claude opens an approval page that asks for your pairing code. Enter it once.

## Using it

Ask for outcomes, not tool calls:

- "What are my agents up to?"
- "Spin up an agent on the laptop to upgrade the test runner and fix whatever breaks."
- "Is the auth refactor done?"
- "The website agent is asking for permission — what does it want?" then "go ahead."
- "Stop the one on the vps."

Claude resolves names against what actually exists. If two things match what you said, it asks instead of guessing.

Anything the conversational tools do not cover — schedules, terminals, worktrees, workspace scripts — is still reachable: Claude can look up the host's full Paseo tool catalog and call it. Ask for what you want and it will find the tool.

## Keep in mind

Your pairing code is the only thing between the internet and your agents. Anyone who has it can start agents on every host you configured, with the same power those machines already give their local clients. Use a long random code, keep the connector behind TLS, and do not run it anywhere you would not run an exposed daemon.

Hosts running a Paseo daemon older than v0.3.0 are reported as needing an update — the connector talks to hosts over an RPC that older daemons do not have.

See [Security](/docs/security) for the full trust model.
