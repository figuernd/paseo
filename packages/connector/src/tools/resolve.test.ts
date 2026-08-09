import { describe, expect, test } from "vitest";

import { requireCandidate, ResolutionError, resolveCandidate } from "./resolve.js";

const hosts = [
  { id: "laptop", aliases: ["laptop", "nathans-mbp"] },
  { id: "mac-mini", aliases: ["mac mini", "studio.local"] },
  { id: "vps", aliases: ["vps", "build-box"] },
];

describe("resolveCandidate", () => {
  test("matches an id exactly", () => {
    expect(resolveCandidate("mac-mini", hosts)).toEqual({ kind: "match", value: hosts[1] });
  });

  test("matches an alias regardless of case and separators", () => {
    expect(resolveCandidate("Mac Mini", hosts)).toEqual({ kind: "match", value: hosts[1] });
    expect(resolveCandidate("mac_mini", hosts)).toEqual({ kind: "match", value: hosts[1] });
  });

  test("matches on a prefix of an alias", () => {
    expect(resolveCandidate("build", hosts)).toEqual({ kind: "match", value: hosts[2] });
  });

  test("matches on a substring when nothing stronger hits", () => {
    expect(resolveCandidate("mbp", hosts)).toEqual({ kind: "match", value: hosts[0] });
  });

  test("reports every candidate when a query matches more than one", () => {
    const agents = [
      { id: "a1", aliases: ["fix the auth bug"] },
      { id: "a2", aliases: ["fix the auth tests"] },
    ];
    expect(resolveCandidate("fix the auth", agents)).toEqual({
      kind: "ambiguous",
      query: "fix the auth",
      matches: agents,
    });
  });

  test("an exact alias wins over another candidate that merely contains it", () => {
    const agents = [
      { id: "a1", aliases: ["deploy"] },
      { id: "a2", aliases: ["deploy the website"] },
    ];
    expect(resolveCandidate("deploy", agents)).toEqual({ kind: "match", value: agents[0] });
  });

  test("matches when the words are present but reordered", () => {
    const agents = [
      { id: "a1", aliases: ["auth refactor for the mobile app"] },
      { id: "a2", aliases: ["website redesign"] },
    ];
    expect(resolveCandidate("mobile auth", agents)).toEqual({ kind: "match", value: agents[0] });
  });

  test("reports no match rather than guessing", () => {
    expect(resolveCandidate("raspberry pi", hosts)).toEqual({
      kind: "none",
      query: "raspberry pi",
    });
  });

  test("an empty query is not a match", () => {
    expect(resolveCandidate("   ", hosts)).toEqual({ kind: "none", query: "   " });
  });

  test("ignores blank aliases instead of matching everything", () => {
    const candidates = [{ id: "x", aliases: [null, undefined, ""] }];
    expect(resolveCandidate("anything", candidates)).toEqual({ kind: "none", query: "anything" });
  });
});

describe("requireCandidate", () => {
  test("returns the single match", () => {
    expect(requireCandidate("vps", hosts, { noun: "host", describe: (h) => h.id })).toBe(hosts[2]);
  });

  test("an ambiguous query asks the user to choose and names the options", () => {
    const agents = [
      { id: "a1", aliases: ["fix auth bug"] },
      { id: "a2", aliases: ["fix auth tests"] },
    ];
    expect(() =>
      requireCandidate("fix auth", agents, {
        noun: "agent",
        describe: (a) => a.aliases[0] as string,
      }),
    ).toThrow(/matches more than one agent: fix auth bug, fix auth tests\. Ask which one/);
  });

  test("an unmatched query lists what is available", () => {
    expect(() => requireCandidate("nas", hosts, { noun: "host", describe: (h) => h.id })).toThrow(
      /No host matches "nas"\. Available: laptop, mac-mini, vps\./,
    );
  });

  test("an empty candidate set says so instead of listing nothing", () => {
    expect(() => requireCandidate("laptop", [], { noun: "host", describe: () => "" })).toThrow(
      ResolutionError,
    );
    expect(() => requireCandidate("laptop", [], { noun: "host", describe: () => "" })).toThrow(
      /no hosts to match/,
    );
  });
});
