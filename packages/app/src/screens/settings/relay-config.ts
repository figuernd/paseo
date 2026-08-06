import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";

export interface RelayCardState {
  isVisible: boolean;
  isEnabled: boolean;
}

export function getRelayCardState(input: {
  isConnected: boolean;
  config: MutableDaemonConfig | null;
}): RelayCardState {
  // COMPAT(relayConfig): daemons before v0.2.6 have no relay block in their
  // mutable config and cannot service the patch, so the card stays hidden
  // rather than rendering a switch that would fail on tap.
  const relay = input.config?.relay;
  return {
    isVisible: input.isConnected && relay !== undefined,
    isEnabled: relay?.enabled === true,
  };
}

export function createRelayPatch(enabled: boolean): MutableDaemonConfigPatch {
  return { relay: { enabled } };
}
