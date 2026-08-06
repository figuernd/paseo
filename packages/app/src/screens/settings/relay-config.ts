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

export interface RelayMutationViewState {
  isSwitchDisabled: boolean;
  errorText: string | null;
}

/**
 * Failures render inline rather than through `Alert.alert`, which is a no-op on
 * React Native Web — and web is where the desktop app runs. The daemon rejects
 * this patch whenever relay is pinned by `PASEO_RELAY_ENABLED` or a CLI flag,
 * and its message names the override to remove, so it has to be visible.
 */
export function getRelayMutationViewState(input: {
  isPending: boolean;
  error: unknown;
}): RelayMutationViewState {
  return {
    isSwitchDisabled: input.isPending,
    errorText: input.error ? toErrorMessage(input.error) : null,
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
