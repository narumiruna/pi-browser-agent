const MAX_STRING_LENGTH = 240
const SECRET_KEY_PATTERN =
  /(?:api.?key|authorization|prompt|source.?text|selected.?text|response.?body|content|text)/iu

function sanitizeValue(value, key = "", seen = new WeakSet()) {
  if (SECRET_KEY_PATTERN.test(key)) {
    return "[REDACTED]"
  }

  if (typeof value === "string") {
    return value.length <= MAX_STRING_LENGTH ? value : `${value.slice(0, MAX_STRING_LENGTH)}…`
  }

  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeValue(item, key, seen))
  }

  if (typeof value !== "object") {
    return String(value)
  }

  if (seen.has(value)) {
    return "[CIRCULAR]"
  }

  seen.add(value)
  const sanitized = {}

  for (const [childKey, childValue] of Object.entries(value).slice(0, 30)) {
    sanitized[childKey] = sanitizeValue(childValue, childKey, seen)
  }

  seen.delete(value)
  return sanitized
}

export function createLogger(component, options = {}) {
  const sink = options.sink || console
  const base = Object.freeze({
    component: String(component || "extension"),
  })

  function write(level, event, detail = {}) {
    const payload = {
      ...base,
      event: String(event || "unknown"),
      ...sanitizeValue(detail),
    }
    const output = sink[level] || sink.log

    output.call(sink, "[Pi Translator]", payload)
    return payload
  }

  return Object.freeze({
    debug: (event, detail) => write("debug", event, detail),
    error: (event, detail) => write("error", event, detail),
    info: (event, detail) => write("info", event, detail),
    warn: (event, detail) => write("warn", event, detail),
  })
}

export { sanitizeValue }
