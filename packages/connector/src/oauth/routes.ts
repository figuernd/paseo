import express from "express";

import { createOAuthStore, type OAuthStore, safeEqual, verifyPkceS256 } from "./store.js";

export const MCP_PATH = "/mcp";
export const SCOPE = "paseo";

export interface OAuthOptions {
  publicUrl: string;
  pairingCode: string;
  statePath: string;
  store?: OAuthStore;
}

export interface OAuthSubsystem {
  router: express.Router;
  /** Resource identifier tokens are bound to. Must match what Claude sends as `resource`. */
  resourceIdentifier: string;
  authenticate(authorizationHeader: string | undefined): boolean;
  challengeHeader(): string;
}

function html(strings: TemplateStringsArray, ...values: string[]): string {
  return strings.reduce((out, chunk, index) => out + chunk + (values[index] ?? ""), "");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function approvalPage(params: {
  clientName: string;
  hidden: Record<string, string>;
  error?: string;
}): string {
  const hiddenFields = Object.entries(params.hidden)
    .map(
      ([key, value]) =>
        `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`,
    )
    .join("\n      ");
  const error = params.error ? `<p class="error">${escapeHtml(params.error)}</p>` : "";
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Connect to Paseo</title>
        <style>
          :root {
            color-scheme: light dark;
          }
          body {
            font-family: ui-sans-serif, system-ui, sans-serif;
            margin: 0;
            display: grid;
            place-items: center;
            min-height: 100vh;
            background: Canvas;
            color: CanvasText;
          }
          main {
            width: min(28rem, calc(100vw - 3rem));
            padding: 2rem;
          }
          h1 {
            font-size: 1.25rem;
            margin: 0 0 0.5rem;
          }
          p {
            margin: 0 0 1rem;
            line-height: 1.5;
            opacity: 0.85;
          }
          label {
            display: block;
            font-size: 0.875rem;
            margin-bottom: 0.375rem;
          }
          input[type="text"] {
            width: 100%;
            padding: 0.625rem 0.75rem;
            font-size: 1rem;
            border-radius: 0.5rem;
            border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
            background: Canvas;
            color: CanvasText;
            box-sizing: border-box;
          }
          button {
            margin-top: 1rem;
            width: 100%;
            padding: 0.7rem 1rem;
            font-size: 1rem;
            font-weight: 600;
            border: 0;
            border-radius: 0.5rem;
            background: CanvasText;
            color: Canvas;
            cursor: pointer;
          }
          .error {
            color: #b00020;
            font-weight: 500;
          }
          .warn {
            font-size: 0.8125rem;
            opacity: 0.7;
          }
        </style>
      </head>
      <body>
        <main>
          <h1>Connect ${escapeHtml(params.clientName)} to Paseo</h1>
          <p>
            This grants it permission to start, inspect, and stop agents on every host this
            connector reaches.
          </p>
          ${error}
          <form method="post" action="approve">
            ${hiddenFields}
            <label for="pairingCode">Pairing code</label>
            <input
              id="pairingCode"
              name="pairingCode"
              type="text"
              autocomplete="one-time-code"
              autofocus
              required
            />
            <button type="submit">Allow access</button>
          </form>
          <p class="warn">
            The pairing code is in your connector config. Do not approve a request you did not
            start.
          </p>
        </main>
      </body>
    </html>`;
}

export function createOAuthSubsystem(options: OAuthOptions): OAuthSubsystem {
  const store = options.store ?? createOAuthStore({ statePath: options.statePath });
  const issuer = options.publicUrl;
  const resourceIdentifier = `${options.publicUrl}${MCP_PATH}`;
  const router = express.Router();

  router.use(express.json({ limit: "1mb" }));
  router.use(express.urlencoded({ extended: false }));

  // RFC 9728. Claude reads this to find the authorization server. The suffixed form is what a
  // client derives from a resource URL with a path, the bare form is the spec default; serve both.
  const protectedResourceMetadata = (_req: express.Request, res: express.Response) => {
    res.json({
      resource: resourceIdentifier,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: [SCOPE],
    });
  };
  router.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
  router.get(`/.well-known/oauth-protected-resource${MCP_PATH}`, protectedResourceMetadata);

  // RFC 8414.
  router.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [SCOPE],
    });
  });

  // RFC 7591. Registration is open, which is safe only because a registered client still cannot
  // obtain a token without the pairing code on the approval page.
  router.post("/oauth/register", (req, res) => {
    const body = (req.body ?? {}) as { client_name?: unknown; redirect_uris?: unknown };
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((uri): uri is string => typeof uri === "string")
      : [];
    if (redirectUris.length === 0) {
      res
        .status(400)
        .json({ error: "invalid_redirect_uri", error_description: "redirect_uris is required" });
      return;
    }
    for (const uri of redirectUris) {
      let parsed: URL;
      try {
        parsed = new URL(uri);
      } catch {
        res
          .status(400)
          .json({ error: "invalid_redirect_uri", error_description: `Not a URL: ${uri}` });
        return;
      }
      if (
        parsed.protocol !== "https:" &&
        parsed.hostname !== "localhost" &&
        parsed.hostname !== "127.0.0.1"
      ) {
        res.status(400).json({
          error: "invalid_redirect_uri",
          error_description: "Redirect URIs must be https or loopback",
        });
        return;
      }
    }

    const client = store.registerClient({
      clientName: typeof body.client_name === "string" ? body.client_name : "Unnamed MCP client",
      redirectUris,
    });
    res.status(201).json({
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  router.get("/oauth/authorize", (req, res) => {
    const query = req.query as Record<string, string | undefined>;
    const client = query.client_id ? store.getClient(query.client_id) : undefined;
    if (!client) {
      res.status(400).send("Unknown client_id. Register before authorizing.");
      return;
    }
    const redirectUri = query.redirect_uri ?? "";
    // Exact match only: a prefix or origin check here is what open-redirect attacks live on.
    if (!client.redirectUris.includes(redirectUri)) {
      res.status(400).send("redirect_uri does not match a registered redirect URI.");
      return;
    }
    if (query.response_type !== "code") {
      res.status(400).send("Only response_type=code is supported.");
      return;
    }
    if (!query.code_challenge || query.code_challenge_method !== "S256") {
      res.status(400).send("PKCE with code_challenge_method=S256 is required.");
      return;
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(
      approvalPage({
        clientName: client.clientName,
        hidden: {
          client_id: client.clientId,
          redirect_uri: redirectUri,
          code_challenge: query.code_challenge,
          state: query.state ?? "",
          resource: query.resource ?? resourceIdentifier,
        },
      }),
    );
  });

  router.post("/oauth/approve", (req, res) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const client = body.client_id ? store.getClient(body.client_id) : undefined;
    const redirectUri = body.redirect_uri ?? "";
    if (!client || !client.redirectUris.includes(redirectUri) || !body.code_challenge) {
      res.status(400).send("Invalid authorization request.");
      return;
    }
    if (!body.pairingCode || !safeEqual(body.pairingCode, options.pairingCode)) {
      res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        approvalPage({
          clientName: client.clientName,
          hidden: {
            client_id: client.clientId,
            redirect_uri: redirectUri,
            code_challenge: body.code_challenge,
            state: body.state ?? "",
            resource: body.resource ?? resourceIdentifier,
          },
          error: "That pairing code is not right.",
        }),
      );
      return;
    }

    const code = store.issueCode({
      clientId: client.clientId,
      redirectUri,
      codeChallenge: body.code_challenge,
      resource: body.resource || resourceIdentifier,
      scope: SCOPE,
    });

    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    if (body.state) {
      target.searchParams.set("state", body.state);
    }
    res.redirect(302, target.toString());
  });

  router.post("/oauth/token", (req, res) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;

    if (body.grant_type === "refresh_token") {
      if (!body.refresh_token || !body.client_id) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      const entry = store.consumeRefreshToken(body.refresh_token, body.client_id);
      if (!entry) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      const tokens = store.issueTokens({
        clientId: entry.clientId,
        resource: entry.resource,
        scope: entry.scope,
      });
      res.json({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_type: "Bearer",
        expires_in: tokens.expiresIn,
        scope: entry.scope,
      });
      return;
    }

    if (body.grant_type !== "authorization_code") {
      res.status(400).json({ error: "unsupported_grant_type" });
      return;
    }
    if (!body.code || !body.code_verifier || !body.client_id || !body.redirect_uri) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }

    const entry = store.consumeCode(body.code);
    if (
      !entry ||
      entry.clientId !== body.client_id ||
      entry.redirectUri !== body.redirect_uri ||
      !verifyPkceS256(body.code_verifier, entry.codeChallenge)
    ) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    // A token is only useful against the resource it was requested for.
    if (body.resource && body.resource !== entry.resource) {
      res.status(400).json({ error: "invalid_target" });
      return;
    }

    const tokens = store.issueTokens({
      clientId: entry.clientId,
      resource: entry.resource,
      scope: entry.scope,
    });
    res.json({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      token_type: "Bearer",
      expires_in: tokens.expiresIn,
      scope: entry.scope,
    });
  });

  return {
    router,
    resourceIdentifier,
    authenticate(authorizationHeader) {
      const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader?.trim() ?? "");
      if (!match?.[1]) {
        return false;
      }
      return store.verifyAccessToken(match[1], resourceIdentifier) !== undefined;
    },
    challengeHeader() {
      return `Bearer realm="paseo-connector", resource_metadata="${issuer}/.well-known/oauth-protected-resource${MCP_PATH}"`;
    },
  };
}
