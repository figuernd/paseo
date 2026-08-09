import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";

import { createRelayPatch, getRelayCardState, getRelayMutationViewState } from "./relay-config";

function makeConfig(relay: MutableDaemonConfig["relay"]): MutableDaemonConfig {
  return {
    relay,
    mcp: { injectIntoAgents: false },
    browserTools: { enabled: false },
    providers: {},
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
  };
}

describe("relay card state", () => {
  it("reflects the daemon's current relay state", () => {
    expect(getRelayCardState({ isConnected: true, config: makeConfig({ enabled: true }) })).toEqual(
      {
        isVisible: true,
        isEnabled: true,
      },
    );
    expect(
      getRelayCardState({ isConnected: true, config: makeConfig({ enabled: false }) }),
    ).toEqual({ isVisible: true, isEnabled: false });
  });

  it("hides while disconnected", () => {
    expect(
      getRelayCardState({ isConnected: false, config: makeConfig({ enabled: true }) }),
    ).toEqual({ isVisible: false, isEnabled: true });
  });

  it("hides against a daemon that predates relay config", () => {
    // Rendering a switch the daemon cannot service would fail on tap.
    expect(getRelayCardState({ isConnected: true, config: makeConfig(undefined) })).toEqual({
      isVisible: false,
      isEnabled: false,
    });
    expect(getRelayCardState({ isConnected: true, config: null })).toEqual({
      isVisible: false,
      isEnabled: false,
    });
  });

  it("builds a patch that turns relay off as well as on", () => {
    expect(createRelayPatch(true)).toEqual({ relay: { enabled: true } });
    expect(createRelayPatch(false)).toEqual({ relay: { enabled: false } });
  });
});

describe("relay mutation view state", () => {
  it("surfaces the daemon's rejection inline", () => {
    // Alert.alert is a no-op on React Native Web, so a pinned-relay rejection
    // would be invisible on web and desktop if this were not rendered.
    const error = new Error(
      "Relay is controlled by a daemon launch override. Remove PASEO_RELAY_ENABLED or the relay CLI flag before changing it here.",
    );

    expect(getRelayMutationViewState({ isPending: false, error })).toEqual({
      isSwitchDisabled: false,
      errorText: error.message,
    });
  });

  it("stringifies a non-Error rejection", () => {
    expect(getRelayMutationViewState({ isPending: false, error: "nope" }).errorText).toBe("nope");
  });

  it("disables the switch while the patch is in flight", () => {
    // Prevents a second toggle racing the first.
    expect(getRelayMutationViewState({ isPending: true, error: null })).toEqual({
      isSwitchDisabled: true,
      errorText: null,
    });
  });

  it("shows nothing when idle and unfailed", () => {
    expect(getRelayMutationViewState({ isPending: false, error: null })).toEqual({
      isSwitchDisabled: false,
      errorText: null,
    });
  });
});
