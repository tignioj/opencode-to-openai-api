import { createServer } from "node:http"
import { timingSafeEqual, randomUUID } from "node:crypto"
import { once } from "node:events"
import { config } from "./config.js"
import { ApiError, errorBody } from "./errors.js"
import { OpenCodeClient } from "./opencode-client.js"
import {
  buildPrompt,
  chunkBody,
  completionBody,
  finishReason,
  normalizeResult,
  normalizeStructured,
  openaiToolCall,
  parseChatRequest,
  parseModelName,
  permissionsFor,
  usage,
} from "./openai.js"

const client = new OpenCodeClient(config)
const server = createServer(handle)
server.requestTimeout = 0
server.headersTimeout = 65_000
server.keepAliveTimeout = 65_000

server.listen(config.port, config.host, () => {
  console.log(`OpenAI-compatible API listening on http://${config.host}:${config.port}`)
  console.log(`OpenCode backend: ${config.opencodeBaseUrl}`)
  if (!config.apiKey) console.warn("Warning: API_KEY is empty; the public API is unauthenticated.")
})

async function handle(req, res) {
  setCors(res)
  if (req.method === "OPTIONS") {
    res.writeHead(204)
    return res.end()
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
  try {
    authorize(req)
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz")) {
      const healthy = await client.health()
      return json(res, healthy ? 200 : 503, {
        status: healthy ? "ok" : "unavailable",
        opencode: healthy ? "connected" : "disconnected",
      })
    }
    if (req.method === "GET" && url.pathname === "/v1/models") return await models(req, res)
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") return await chat(req, res)
    throw new ApiError(404, `Unknown endpoint: ${req.method} ${url.pathname}`, "invalid_request_error")
  } catch (error) {
    if (res.headersSent) {
      if (!res.writableEnded) res.end()
      return
    }
    const status = error instanceof ApiError ? error.status : 500
    json(res, status === 499 ? 400 : status, errorBody(error))
  }
}

function authorize(req) {
  if (!config.apiKey) return
  const value = req.headers.authorization
  if (!value?.startsWith("Bearer ")) {
    throw new ApiError(401, "Missing bearer token", "authentication_error", null, "invalid_api_key")
  }
  const actual = Buffer.from(value.slice(7))
  const expected = Buffer.from(config.apiKey)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new ApiError(401, "Invalid bearer token", "authentication_error", null, "invalid_api_key")
  }
}

async function models(req, res) {
  const controller = requestController(req)
  const data = await client.listModels(controller.signal)
  json(res, 200, { object: "list", data })
}

async function chat(req, res) {
  const request = parseChatRequest(await readJson(req))
  const model = parseModelName(request.model)
  const controller = requestController(req)
  const session = await client.createSession({
    model,
    permission: permissionsFor(request),
    signal: controller.signal,
  })
  const prompt = {
    ...buildPrompt(request),
    model,
    ...(request.effort ? { variant: request.effort } : {}),
  }

  try {
    if (request.stream) return await streamChat(req, res, request, session.id, prompt, controller)
    const result = normalizeResult(await client.prompt(session.id, prompt, controller.signal), request)
    const identity = completionIdentity(request.model)
    return json(res, 200, completionBody({ ...identity, result }))
  } finally {
    if (!request.stream) await client.cleanup(session.id)
  }
}

async function streamChat(req, res, request, sessionID, prompt, controller) {
  const identity = completionIdentity(request.model)
  const events = await client.events(controller.signal)
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  })
  res.flushHeaders?.()

  let assistantID
  let assistantInfo = {}
  let sentStructured = false
  let finished = false
  const partTypes = new Map()
  const pendingDeltas = new Map()

  try {
    await writeSse(res, chunkBody({ ...identity, delta: { role: "assistant", content: "" } }))
    await client.promptAsync(sessionID, prompt, controller.signal)

    for await (const event of events) {
      if (event?.properties?.sessionID !== sessionID) continue

      if (event.type === "session.error") {
        const message = event.properties.error?.data?.message ?? event.properties.error?.message ?? "OpenCode failed"
        await writeSse(res, errorBody(new ApiError(502, message, "upstream_error")))
        await writeRaw(res, "data: [DONE]\n\n")
        finished = true
        break
      }

      if (event.type === "message.updated" && event.properties.info?.role === "assistant") {
        assistantID = event.properties.info.id
        assistantInfo = event.properties.info
        if (!sentStructured && assistantInfo.structured !== undefined) {
          sentStructured = await writeStructured(res, identity, assistantInfo.structured)
        }
        continue
      }

      if (event.type === "message.part.updated") {
        const part = event.properties.part
        if (part?.messageID !== assistantID && assistantID) continue
        if (part?.type === "text" || part?.type === "reasoning") {
          partTypes.set(part.id, part.type)
          const pending = pendingDeltas.get(part.id)
          if (pending) {
            await writeDelta(res, identity, part.type, pending)
            pendingDeltas.delete(part.id)
          }
        }
        continue
      }

      if (event.type === "message.part.delta" && event.properties.field === "text") {
        if (assistantID && event.properties.messageID !== assistantID) continue
        const type = partTypes.get(event.properties.partID)
        if (type) await writeDelta(res, identity, type, event.properties.delta)
        else {
          pendingDeltas.set(
            event.properties.partID,
            (pendingDeltas.get(event.properties.partID) || "") + event.properties.delta,
          )
        }
        continue
      }

      if (event.type === "session.idle") {
        if (assistantID) {
          const final = await client.getMessage(sessionID, assistantID, controller.signal).catch(() => undefined)
          if (final?.info) assistantInfo = final.info
          if (!sentStructured && assistantInfo.structured !== undefined) {
            sentStructured = await writeStructured(res, identity, assistantInfo.structured)
          }
        }
        const structured = normalizeStructured(assistantInfo.structured)
        await writeSse(
          res,
          chunkBody({
            ...identity,
            delta: {},
            finishReason:
              structured?.action === "tool_calls" && structured.tool_calls.length
                ? "tool_calls"
                : finishReason(assistantInfo.finish),
          }),
        )
        if (request.stream_options?.include_usage) {
          await writeSse(res, {
            ...chunkBody({ ...identity, delta: {}, usage: usage(assistantInfo.tokens) }),
            choices: [],
          })
        }
        await writeRaw(res, "data: [DONE]\n\n")
        finished = true
        break
      }
    }
  } catch (error) {
    if (!controller.signal.aborted && !res.writableEnded) {
      await writeSse(res, errorBody(error)).catch(() => undefined)
      await writeRaw(res, "data: [DONE]\n\n").catch(() => undefined)
    }
  } finally {
    if (!finished) await client.abort(sessionID)
    await client.cleanup(sessionID)
    if (!res.writableEnded) res.end()
  }
}

async function writeDelta(res, identity, type, text) {
  if (!text) return
  const delta = type === "reasoning" ? { reasoning_content: text } : { content: text }
  await writeSse(res, chunkBody({ ...identity, delta }))
}

async function writeStructured(res, identity, value) {
  const structured = normalizeStructured(value)
  if (!structured) return false
  if (structured.action === "message") {
    if (structured.content) await writeSse(res, chunkBody({ ...identity, delta: { content: structured.content } }))
    return true
  }
  for (const [index, call] of structured.tool_calls.entries()) {
    await writeSse(
      res,
      chunkBody({
        ...identity,
        delta: {
          tool_calls: [{ index, ...openaiToolCall(call) }],
        },
      }),
    )
  }
  return true
}

function completionIdentity(model) {
  return {
    id: `chatcmpl-${randomUUID().replaceAll("-", "")}`,
    created: Math.floor(Date.now() / 1000),
    model,
  }
}

function requestController(req) {
  const controller = new AbortController()
  req.once("aborted", () => controller.abort())
  req.once("close", () => {
    if (!req.complete) controller.abort()
  })
  return controller
}

async function readJson(req) {
  const contentLength = Number(req.headers["content-length"])
  if (Number.isFinite(contentLength) && contentLength > config.maxBodyBytes) {
    throw new ApiError(413, `Request body exceeds ${config.maxBodyBytes} bytes`, "invalid_request_error")
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > config.maxBodyBytes) {
      throw new ApiError(413, `Request body exceeds ${config.maxBodyBytes} bytes`, "invalid_request_error")
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new ApiError(400, "Request body is not valid JSON", "invalid_request_error")
  }
}

async function writeSse(res, value) {
  await writeRaw(res, `data: ${JSON.stringify(value)}\n\n`)
}

async function writeRaw(res, value) {
  if (res.write(value)) return
  await once(res, "drain")
}

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  })
  res.end(body)
}

function setCors(res) {
  res.setHeader("access-control-allow-origin", "*")
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS")
  res.setHeader("access-control-allow-headers", "Authorization, Content-Type")
}

function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 10_000).unref()
}

process.once("SIGINT", () => shutdown("SIGINT"))
process.once("SIGTERM", () => shutdown("SIGTERM"))
