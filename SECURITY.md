# Security

Paseo follows a client-server architecture, similar to Docker. The daemon runs on your machine and manages your coding agents. Clients (the mobile app, CLI, or web interface) connect to the daemon to monitor and control those agents.

Your code never leaves your machine. Paseo is a local-first tool that connects directly to your development environment.

## Architecture

The Paseo daemon can run anywhere you want to execute agents: your laptop, a Mac Mini, a VPS, or a Docker container. The daemon listens for connections and manages agent lifecycles.

Clients connect to the daemon over WebSocket. There are two ways to establish this connection:

- **Relay connection** — The daemon connects outbound to our relay server, and clients meet it there. No open ports required.
- **Direct connection** — The daemon listens on a network address and clients connect directly.

## Relay threat model

The relay is designed to be untrusted. All traffic between your phone and daemon is end-to-end encrypted. The relay server cannot read your messages, see your code, or modify traffic without detection. Even if the relay is compromised, your data remains protected.

### How it works

1. The daemon generates a persistent Curve25519 keypair on first run and stores it at `$PASEO_HOME/daemon-keypair.json` with mode `0600`
2. The pairing URL (rendered as a QR code or opened directly) carries the daemon's public key and a single-use enrollment token in its URL fragment (`https://app.paseo.sh/#offer=...`). Fragments are not sent to the web server, so `app.paseo.sh` never sees either value.
3. When the phone connects via the relay, it sends an `e2ee_hello` message containing its own Curve25519 public key, plus the enrollment token until it is enrolled. That keypair is the device's identity for the host, generated at pairing time and kept afterwards, because enrollment binds the daemon's approval to it. The daemon checks the key against its paired-client list before deriving a shared key or replying, and will not process any application messages until the handshake completes.
4. Both sides perform a Curve25519 ECDH key exchange to derive a shared key. All subsequent messages are encrypted with XSalsa20-Poly1305 (NaCl `box`). The encrypted bundle is `[24-byte nonce][ciphertext]`. Peers optionally negotiate `binaryCiphertext` in `e2ee_hello` / `e2ee_ready`: negotiated application text is carried as a base64 WebSocket text frame, while application binary is carried as a raw WebSocket binary frame. A peer that does not negotiate the capability uses base64 text frames for both kinds.

The WebSocket opcode is preserved end to end after negotiation; the receiver never guesses whether authenticated plaintext is text or binary from its byte contents. The plaintext handshake remains WebSocket text and contains only public keys and capability declarations.

The relay sees only: IP addresses, timing, message sizes, session IDs, and the plaintext `e2ee_hello` / `e2ee_ready` handshake frames (which contain only public keys). It cannot read message contents, forge messages, or derive encryption keys from observing the handshake.

### Why the relay can't attack you

The daemon requires a valid cryptographic handshake before processing any commands. A compromised relay cannot:

- **Impersonate the daemon to your phone** — Without the daemon's secret key, it cannot derive the shared key, so any traffic it injects fails authenticated decryption on the phone
- **Send commands as you** — The daemon only accepts traffic that decrypts and authenticates under a shared key derived with its own secret key, and only from a client key it has enrolled. Protection comes from the daemon's secret key never leaving the daemon, plus the enrollment step described under Trust model.
- **Read your traffic** — All messages are encrypted with XSalsa20-Poly1305 (NaCl box) after the handshake
- **Forge messages** — NaCl box provides authenticated encryption; tampered messages are rejected
- **Replay old messages across sessions** — Each session derives fresh encryption keys, so ciphertext from one session cannot be replayed into another session. Within a live session, replay protection is not yet implemented; the protocol uses random nonces and does not track nonce reuse or message counters.

### Trust model

The QR code or pairing link is the trust anchor. It carries the daemon's public key and a single-use enrollment token.

The public key alone is not a credential — it appears in every offer the daemon renders. The enrollment token is what admits a device: the daemon redeems it on that device's first handshake, records the device's key, and discards the token. A link that leaks therefore admits at most the first device to use it, and that device shows up in `paseo daemon clients` rather than going unnoticed. Unredeemed tokens expire after 10 minutes.

After enrollment, the device's own key is what gets it back in, so the link is spent and no longer worth anything. The app stores that key with the host profile; the CLI keeps one at `$PASEO_HOME/cli-client-key`, mode `0600`; the connector keeps one next to its config as `connector-client-key`, same mode. Anything that can read those files can reconnect as that device until you revoke it.

Manage paired devices from the daemon machine:

```
paseo daemon clients             # list paired devices and when each was last seen
paseo daemon revoke <fingerprint># revoke one device
paseo daemon rotate-key          # revoke every device
```

Revocation closes the device's live sessions immediately, not at its next reconnect, and drops any outstanding pairing offers.

## Push notifications

Push is the one path that leaves your machine outside the relay's end-to-end encryption. The daemon posts to Expo's push service, which forwards through Apple or Google. Those three parties see whatever the notification carries.

So the notification carries as little as possible. By default the body is a fixed string — "Finished working.", "Permission requested." — and the data payload holds only the IDs needed to open the right screen: server, workspace, agent or terminal. No file paths, no working directory, no agent output.

Set `daemon.push.includeContent` to `true` in `config.json` to put the agent's message preview in the body instead. That preview is up to 220 characters of assistant output, or for a permission prompt the tool input itself, which is typically the command awaiting approval. Turn it on when you want a useful lock screen and accept that Expo, Apple, and Google see it.

Notifications delivered over the WebSocket are unaffected either way. Those reach paired clients inside the encrypted channel and always carry the full preview, so the in-app experience is the same.

Nothing is sent until a mobile client registers a push token, which requires granting the OS notification permission. Deny it, or use only the desktop app, CLI, or browser, and the daemon never contacts Expo.

## Local daemon trust boundary

By default, the daemon binds to `127.0.0.1`. With no password configured, the local control plane is trusted by network reachability — anything that can reach the daemon socket can control the daemon. This is the same security model Docker documents for its daemon: the security boundary is access to the socket or listening address.

The daemon also supports an optional shared-secret password (set via `auth.password` in `config.json` or the `PASEO_PASSWORD` env var; stored bcrypt-hashed). When configured, every HTTP request must carry `Authorization: Bearer <password>` and every WebSocket upgrade must include a `Sec-WebSocket-Protocol: paseo.bearer.<password>` subprotocol. Browser WebSocket cannot set custom headers, which is why the token rides in the subprotocol. Health (`GET /api/health`) and CORS preflight (`OPTIONS`) are exempt. The password is intended for direct-TCP exposure (e.g. `tcp://host:port?ssl=true&password=...`); it is **not** a substitute for the relay's E2E encryption when traversing untrusted networks.

Connected clients are trusted operators of the daemon user. File previews follow that authority: a preview request may read any regular file the daemon process can read, while keeping path normalization and symlink checks in the daemon file service. Workspace-relative paths remain a UI convenience, not a security boundary.

If you expose the daemon beyond loopback, such as by binding to `0.0.0.0`, forwarding it through a tunnel or reverse proxy, or publishing it from a Docker container, you are responsible for restricting and securing that access. Setting a password is strongly recommended in that case.

In Docker, the official image runs the daemon and agents as the non-root
`paseo` user by default. Mounted workspaces and credentials are still fully
available to anything the agents run inside the container.

For remote access, use the relay connection. It is the supported path for reaching the daemon off-machine, and it adds end-to-end encryption plus a pairing handshake before commands are accepted.

Host header validation and CORS origin checks are defense-in-depth controls for localhost exposure. They help block DNS rebinding and browser-based attacks, but they do not replace network isolation.

## Claude connector trust boundary

The connector (`packages/connector`) is the one Paseo component designed to be published on the
internet. It exposes an OAuth 2.1-protected MCP endpoint to Claude and holds connections — including
relay keys — to every daemon you configure. Treat it as a trusted client of those daemons, at the
same authority level as your phone.

Claude authenticates with OAuth 2.1: dynamic client registration, PKCE with S256, exact redirect-URI
matching, and tokens bound to the connector's resource identifier. Registration is deliberately open
because registering grants nothing; a token is issued only after the approval page accepts your
pairing code. That code is therefore the whole boundary. Anyone who has it can start agents on every
configured host. Access tokens expire in an hour, refresh tokens rotate on use, and both are
persisted as SHA-256 hashes so the state file cannot be replayed.

Because the approval page is the one place a secret is checked and it is reachable by anyone who can
resolve the connector's name, two controls are enforced rather than recommended. The connector
refuses to start unless the pairing code is at least 24 characters with real character variety.
Failed approvals back off exponentially, keyed on the source address rather than `client_id` —
registration is open, so an attacker can mint a fresh client id per guess and a client-keyed limiter
would never fire. A looser global counter sits behind the per-address one so a distributed attack is
slowed without letting a single attacker lock the owner out.

The connector adds no sandbox of its own. An agent it starts has exactly the authority that daemon's
local clients already have. Run the connector behind TLS you control, and do not expose it if you
would not also expose the daemons behind it.

## DNS rebinding protection

CORS is not a complete security boundary. It controls which browser origins can make requests, but does not prevent a malicious website from resolving its domain to your local machine (DNS rebinding).

Paseo validates the `Host` header on every HTTP request and every WebSocket upgrade against an allowlist (Vite-style semantics). By default, only `localhost`, `*.localhost`, and any literal IP address (IPv4 or IPv6) are accepted. Additional hostnames can be configured via `hostnames` in `config.json` or the `PASEO_HOSTNAMES` env var (comma-separated; entries beginning with `.` match a domain and its subdomains; the value `true` disables the allowlist entirely). Requests with unrecognized hosts are rejected with `403 Host not allowed`.

## HTML file preview

Previewing an `.html` file in the file pane renders it as a page, so markup an agent wrote — or markup that arrived with a repo you cloned — executes when you open it. The preview is built to contain that, not to trust it.

The document loads with an opaque origin and a policy that permits inline script and style and refuses everything else: no remote script, font, image, or media; no `fetch`, XHR, WebSocket, or beacon; no form posts; no plugins; no nested frames. It has no access to Paseo's DOM, and storage and cookie APIs throw inside it rather than returning anything. It cannot navigate the top window, and it cannot open popups. It cannot read any file but itself.

One gap remains on web and desktop: a sandboxed document may navigate _itself_, and no CSP directive in current browsers prevents that. `navigate-to` was dropped from CSP Level 3 and is not enforced, and `<meta http-equiv="refresh">` needs no script at all. A hostile page can therefore reach a server by navigating away, carrying data available inside the preview, such as its own contents, browser and device properties, user input inside the page, and your IP address. It cannot read Paseo, another file, storage, or cookies.

Native builds narrow this gap rather than closing it outright. The WebView refuses every navigation after the initial document, but that decision is made in the app's JavaScript, and on Android the WebView falls back to allowing a navigation when the decision doesn't come back in time. Treat it as a strong mitigation, not a guarantee: if the JS thread is stalled at the moment a page navigates, the same leak is possible there too.

If you don't trust a page, read it in `Source`, which executes nothing. Source is available as an editable view on supported web hosts and a read-only view everywhere else.

## Agent authentication

Paseo wraps agent CLIs (Claude Code, Codex, OpenCode) but does not manage their authentication. Each agent provider handles its own credentials. Paseo never stores or transmits provider API keys. Agents run in your user context with your existing credentials.

## Forge host trust

Paseo only talks to a forge host that is either a known cloud host or one the forge CLI is already authenticated to. It never probes or routes credentials to an unauthenticated, remote-derived host.

## Reporting vulnerabilities

If you discover a security vulnerability, please report it privately by emailing hello@moboudra.com. Do not open a public issue.
