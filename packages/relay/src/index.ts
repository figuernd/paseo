export type { ConnectionRole, RelaySessionAttachment } from "./types.js";

export {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSharedKey,
  encrypt,
  decrypt,
} from "./crypto.js";

export {
  ALLOW_ANY_CLIENT,
  base64EncryptedWireByteLength,
  ClientNotPairedError,
  createClientChannel,
  createDaemonChannel,
  EncryptedChannel,
  maxBase64EncryptedPlaintextByteLength,
} from "./encrypted-channel.js";
export type { ClientAuthorizer, Transport, EncryptedChannelEvents } from "./encrypted-channel.js";
