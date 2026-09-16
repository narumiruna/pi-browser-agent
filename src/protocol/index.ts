export {
  BRIDGE_CAPABILITIES,
  type BridgeCapability,
  isBridgeCapability,
} from "./capabilities.js"
export {
  BRIDGE_ERROR_CODES,
  BridgeError,
  type BridgeErrorCode,
  type BridgeErrorData,
  isBridgeErrorCode,
  toBridgeError,
} from "./errors.js"
export {
  type AuthChallengeFrame,
  type AuthResponseFrame,
  type AuthResultFrame,
  BRIDGE_METHODS,
  type BridgeMethod,
  type CancelFrame,
  type EventFrame,
  type HelloFrame,
  isBridgeMethod,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  type PingFrame,
  type PongFrame,
  type ProtocolFrame,
  type RequestFrame,
  type ResponseFrame,
  type TabContext,
} from "./messages.js"
export {
  isJsonObject,
  isJsonValue,
  isProtocolFrame,
  isTabContext,
  parseProtocolFrame,
  serializeProtocolFrame,
  truncateUtf8,
} from "./schemas.js"
export {
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  MAX_REQUEST_TIMEOUT_MS,
  MAX_TEXT_RESULT_BYTES,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "./version.js"
