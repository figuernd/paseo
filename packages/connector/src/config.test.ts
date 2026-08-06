import { describe, expect, test } from "vitest";

import { normalizePublicUrl, parseListen, resolveConnectorConfig } from "./config.js";

function load(options: { file?: unknown; env?: NodeJS.ProcessEnv }) {
  return resolveConnectorConfig({
    env: { PASEO_CONNECTOR_CONFIG: "/tmp/connector.json", ...options.env },
    readFile: () => {
      if (options.file === undefined) {
        const error = new Error("ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return JSON.stringify(options.file);
    },
  });
}

const STRONG_CODE = "Qk7pR2vL9wXz4mNb8sTy6HdF";

const minimal = {
  publicUrl: "https://paseo.example.com",
  pairingCode: STRONG_CODE,
  hosts: [{ name: "laptop", endpoint: "tcp://127.0.0.1:6767" }],
};

describe("parseListen", () => {
  test("splits host and port", () => {
    expect(parseListen("127.0.0.1:6790")).toEqual({ host: "127.0.0.1", port: 6790 });
  });

  test("handles a bracketed IPv6 address", () => {
    expect(parseListen("[::1]:6790")).toEqual({ host: "::1", port: 6790 });
  });

  test("rejects a value with no port", () => {
    expect(() => parseListen("127.0.0.1")).toThrow(/expected host:port/);
  });

  test("rejects an out-of-range port", () => {
    expect(() => parseListen("127.0.0.1:99999")).toThrow(/Invalid listen/);
  });
});

describe("normalizePublicUrl", () => {
  test("drops a trailing slash so the resource identifier is canonical", () => {
    expect(normalizePublicUrl("https://paseo.example.com/")).toBe("https://paseo.example.com");
  });

  test("drops query and fragment", () => {
    expect(normalizePublicUrl("https://paseo.example.com/?a=1#b")).toBe(
      "https://paseo.example.com",
    );
  });

  test("keeps a path prefix, which a reverse proxy may need", () => {
    expect(normalizePublicUrl("https://example.com/paseo")).toBe("https://example.com/paseo");
  });

  test("rejects plain http on a real host", () => {
    expect(() => normalizePublicUrl("http://paseo.example.com")).toThrow(/must be https/);
  });

  test("allows http on loopback so the flow can be exercised locally", () => {
    expect(normalizePublicUrl("http://127.0.0.1:6790")).toBe("http://127.0.0.1:6790");
  });
});

describe("resolveConnectorConfig", () => {
  test("reads hosts and defaults the listen address", () => {
    const config = load({ file: minimal });
    expect(config.listen).toEqual({ host: "127.0.0.1", port: 6790 });
    expect(config.publicUrl).toBe("https://paseo.example.com");
    expect(config.hosts).toEqual([{ name: "laptop", endpoint: "tcp://127.0.0.1:6767" }]);
  });

  test("environment variables win over the file", () => {
    const config = load({
      file: minimal,
      env: {
        PASEO_CONNECTOR_LISTEN: "0.0.0.0:9000",
        PASEO_CONNECTOR_PUBLIC_URL: "https://other.example.com",
        PASEO_CONNECTOR_PAIRING_CODE: "fR0m3nv-Wq8xLc2vNb5tYzHd",
      },
    });
    expect(config.listen).toEqual({ host: "0.0.0.0", port: 9000 });
    expect(config.publicUrl).toBe("https://other.example.com");
    expect(config.pairingCode).toBe("fR0m3nv-Wq8xLc2vNb5tYzHd");
  });

  test("a missing config file is reported as missing settings, not as a crash", () => {
    expect(() => load({})).toThrow(/No publicUrl configured/);
  });

  test("refuses to start without a pairing code", () => {
    expect(() => load({ file: { publicUrl: "https://paseo.example.com", hosts: [] } })).toThrow(
      /No pairingCode configured/,
    );
  });

  // The pairing code is the only secret between the public internet and every configured host,
  // so a guessable one has to be refused at startup rather than trusted to rate limiting alone.
  test("refuses a short pairing code and says how to make one", () => {
    expect(() => load({ file: { ...minimal, pairingCode: "hunter2" } })).toThrow(
      /at least 24 characters \(got 7\).*openssl rand -base64 24/s,
    );
  });

  test("refuses a long code with too little variety", () => {
    expect(() => load({ file: { ...minimal, pairingCode: "abababababababababababab" } })).toThrow(
      /repeats too few distinct characters/,
    );
  });

  test("a code supplied by environment is held to the same bar", () => {
    expect(() => load({ file: minimal, env: { PASEO_CONNECTOR_PAIRING_CODE: "short" } })).toThrow(
      /at least 24 characters/,
    );
  });

  test("accepts a code of the shape the docs tell you to generate", () => {
    expect(load({ file: { ...minimal, pairingCode: STRONG_CODE } }).pairingCode).toBe(STRONG_CODE);
  });

  test("rejects a host that gives both an endpoint and an offer", () => {
    expect(() =>
      load({
        file: {
          ...minimal,
          hosts: [
            {
              name: "laptop",
              endpoint: "tcp://127.0.0.1:6767",
              offer: "https://app.paseo.sh/#offer=x",
            },
          ],
        },
      }),
    ).toThrow(/exactly one of endpoint or offer/);
  });

  test("rejects a host that gives neither", () => {
    expect(() => load({ file: { ...minimal, hosts: [{ name: "laptop" }] } })).toThrow(
      /exactly one of endpoint or offer/,
    );
  });

  test("rejects duplicate host names, which would make voice references ambiguous", () => {
    expect(() =>
      load({
        file: {
          ...minimal,
          hosts: [
            { name: "laptop", endpoint: "tcp://127.0.0.1:6767" },
            { name: "Laptop", endpoint: "tcp://127.0.0.1:6768" },
          ],
        },
      }),
    ).toThrow(/Duplicate host name/);
  });
});
