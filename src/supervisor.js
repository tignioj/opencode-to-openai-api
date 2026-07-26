import { spawn } from "node:child_process"

const backend = spawn(
  "opencode",
  [
    "serve",
    "--hostname",
    process.env.OPENCODE_BACKEND_HOST || "127.0.0.1",
    "--port",
    process.env.OPENCODE_BACKEND_PORT || "4096",
  ],
  { stdio: "inherit", env: process.env },
)
const api = spawn(process.execPath, ["src/server.js"], { stdio: "inherit", env: process.env })
let stopping = false

function stop(signal = "SIGTERM") {
  if (stopping) return
  stopping = true
  backend.kill(signal)
  api.kill(signal)
}

backend.once("exit", (code, signal) => {
  if (!stopping) {
    console.error(`OpenCode backend exited (${signal || code}); stopping API gateway.`)
    stop()
    process.exitCode = code || 1
  }
})
api.once("exit", (code, signal) => {
  if (!stopping) {
    console.error(`API gateway exited (${signal || code}); stopping OpenCode backend.`)
    stop()
    process.exitCode = code || 1
  }
})
process.once("SIGINT", () => stop("SIGINT"))
process.once("SIGTERM", () => stop("SIGTERM"))
