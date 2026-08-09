import { describe, expect, test } from "vitest";

import { resolveHostTarget } from "./host-registry.js";

function offerUrl(overrides: Record<string, unknown> = {}): string {
  const payload = {
    v: 2,
    serverId: "srv-abc",
    daemonPublicKeyB64: "ZGFlbW9uLXB1YmxpYy1rZXk=",
    enroll: "single-use-enrollment-token",
    relay: { endpoint: "relay.paseo.sh:443" },
    ...overrides,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
  return `https://app.paseo.sh/#offer=${encoded}`;
}

describe("resolveHostTarget", () => {
  /**
   * The daemon's public key rides in every pairing offer, so it is not what admits a client.
   * Dropping the enrollment token would leave the connector able to complete the crypto
   * handshake and still be refused a relay session.
   */
  test("a pairing offer carries its enrollment token through to the transport", () => {
    const target = resolveHostTarget({ name: "mac mini", offer: offerUrl() });

    expect(target).toEqual({
      kind: "relay",
      url: expect.stringContaining("relay.paseo.sh"),
      daemonPublicKeyB64: "ZGFlbW9uLXB1YmxpYy1rZXk=",
      enrollToken: "single-use-enrollment-token",
    });
  });

  test("an offer without an enrollment token is refused rather than half-connected", () => {
    expect(() =>
      resolveHostTarget({ name: "mac mini", offer: offerUrl({ enroll: undefined }) }),
    ).toThrow(/not a Paseo pairing URL|enroll/i);
  });

  test("a URL with no offer fragment names the problem", () => {
    expect(() => resolveHostTarget({ name: "mac mini", offer: "https://app.paseo.sh/" })).toThrow(
      /offer is not a Paseo pairing URL/,
    );
  });

  describe("direct endpoints", () => {
    test("a tcp endpoint becomes a websocket url and keeps its password", () => {
      const target = resolveHostTarget({
        name: "vps",
        endpoint: "tcp://10.0.0.5:6767?ssl=true&password=hunter2",
      });

      expect(target).toEqual({
        kind: "direct",
        url: "wss://10.0.0.5:6767/ws",
        password: "hunter2",
      });
    });

    test("an explicit host password wins over one embedded in the endpoint", () => {
      const target = resolveHostTarget({
        name: "vps",
        endpoint: "tcp://10.0.0.5:6767?password=from-uri",
        password: "from-config",
      });

      expect(target).toMatchObject({ password: "from-config" });
    });

    test("a bare host:port is treated as a plain websocket endpoint", () => {
      expect(resolveHostTarget({ name: "laptop", endpoint: "127.0.0.1:6767" })).toEqual({
        kind: "direct",
        url: "ws://127.0.0.1:6767/ws",
      });
    });

    test("a unix socket endpoint carries its socket path", () => {
      expect(resolveHostTarget({ name: "local", endpoint: "unix:///tmp/paseo.sock" })).toEqual({
        kind: "direct",
        url: "ws+unix:///tmp/paseo.sock:/ws",
        socketPath: "/tmp/paseo.sock",
      });
    });
  });
});
