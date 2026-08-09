import { isLoopbackHostname } from "./hostnames.js";

/**
 * Whether a relay endpoint should use TLS when nothing says otherwise.
 *
 * Anything reachable over a network defaults to TLS. A relay carries the E2EE
 * handshake frames and every byte of connection metadata, so putting that in
 * the clear should be a deliberate choice rather than what you get by pointing
 * the daemon at your own host and configuring nothing else. Loopback endpoints
 * are the local-development relay and stay plaintext.
 *
 * Lives in its own module so config, bootstrap, and the pairing offer can share
 * one answer without importing each other.
 */
export function relayEndpointDefaultsToTls(endpoint: string): boolean {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    return true;
  }
  const host = trimmed.startsWith("[")
    ? trimmed.slice(0, trimmed.indexOf("]") + 1)
    : (trimmed.split(":")[0] ?? trimmed);
  return !isLoopbackHostname(host);
}
