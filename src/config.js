function integer(name, fallback, minimum = 1) {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`)
  }
  return value
}

function boolean(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false
  throw new Error(`${name} must be a boolean`)
}

export const config = Object.freeze({
  host: process.env.HOST || "0.0.0.0",
  port: integer("PORT", 10000),
  apiKey: process.env.API_KEY || "",
  maxBodyBytes: integer("MAX_BODY_BYTES", 10 * 1024 * 1024),
  opencodeBaseUrl: (process.env.OPENCODE_BASE_URL || "http://127.0.0.1:4096").replace(/\/+$/, ""),
  opencodeDirectory: process.env.OPENCODE_DIRECTORY || process.cwd(),
  opencodeUsername: process.env.OPENCODE_SERVER_USERNAME || "opencode",
  opencodePassword: process.env.OPENCODE_SERVER_PASSWORD || "",
  requestTimeoutMs: integer("OPENCODE_REQUEST_TIMEOUT_MS", 10 * 60 * 1000),
  cleanupSessions: boolean("CLEANUP_SESSIONS", true),
  modelCacheMs: integer("MODEL_CACHE_MS", 15 * 1000, 0),
})
