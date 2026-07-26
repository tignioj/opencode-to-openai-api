import { ApiError, upstreamMessage } from "./errors.js"

export class OpenCodeClient {
  constructor(config) {
    this.baseUrl = config.opencodeBaseUrl
    this.directory = config.opencodeDirectory
    this.username = config.opencodeUsername
    this.password = config.opencodePassword
    this.timeoutMs = config.requestTimeoutMs
    this.cleanupSessions = config.cleanupSessions
    this.modelCacheMs = config.modelCacheMs
    this.modelCache = undefined
  }

  async listModels(signal) {
    const now = Date.now()
    if (this.modelCache && now - this.modelCache.time <= this.modelCacheMs) return this.modelCache.data
    const response = await this.request("/config/providers", { signal })
    const data = await response.json()
    const models = (data.providers ?? []).flatMap((provider) =>
      Object.values(provider.models ?? {}).map((model) => ({
        id: `${provider.id}/${model.id}`,
        object: "model",
        created: dateSeconds(model.release_date),
        owned_by: provider.id,
        root: `${provider.id}/${model.id}`,
        parent: null,
        permission: [],
        capabilities: model.capabilities,
        context_window: model.limit?.context,
        max_output_tokens: model.limit?.output,
        reasoning_efforts: Object.keys(model.variants ?? {}),
      })),
    )
    this.modelCache = { time: now, data: models }
    return models
  }

  async createSession({ model, permission, signal }) {
    const response = await this.request("/session", {
      method: "POST",
      body: {
        title: "OpenAI API request",
        model: { id: model.modelID, providerID: model.providerID },
        permission,
        metadata: { source: "opencode-to-openai-api" },
      },
      signal,
    })
    return response.json()
  }

  async prompt(sessionID, payload, signal) {
    const response = await this.request(`/session/${encodeURIComponent(sessionID)}/message`, {
      method: "POST",
      body: payload,
      signal,
    })
    return response.json()
  }

  async promptAsync(sessionID, payload, signal) {
    await this.request(`/session/${encodeURIComponent(sessionID)}/prompt_async`, {
      method: "POST",
      body: payload,
      signal,
    })
  }

  async events(signal) {
    const response = await this.request("/event", { signal, timeout: false })
    if (!response.body) throw new ApiError(502, "OpenCode event stream had no response body", "upstream_error")
    return parseSse(response.body, signal)
  }

  async getMessage(sessionID, messageID, signal) {
    const response = await this.request(
      `/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(messageID)}`,
      { signal },
    )
    return response.json()
  }

  async abort(sessionID) {
    await this.request(`/session/${encodeURIComponent(sessionID)}/abort`, {
      method: "POST",
      timeout: 10_000,
    }).catch(() => undefined)
  }

  async cleanup(sessionID) {
    if (!this.cleanupSessions) return
    await this.request(`/session/${encodeURIComponent(sessionID)}`, {
      method: "DELETE",
      timeout: 10_000,
    }).catch(() => undefined)
  }

  async health(signal) {
    try {
      await this.request("/config/providers", { signal, timeout: 5_000 })
      return true
    } catch {
      return false
    }
  }

  async request(path, options = {}) {
    const headers = {
      Accept: "application/json",
      "x-opencode-directory": this.directory,
      ...options.headers,
    }
    if (options.body !== undefined) headers["content-type"] = "application/json"
    if (this.password) {
      headers.authorization = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`
    }

    const signals = []
    if (options.signal) signals.push(options.signal)
    if (options.timeout !== false) {
      signals.push(AbortSignal.timeout(typeof options.timeout === "number" ? options.timeout : this.timeoutMs))
    }

    let response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method || "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
      })
    } catch (error) {
      if (options.signal?.aborted) throw new ApiError(499, "Request was cancelled", "request_cancelled", null, null, error)
      if (error?.name === "TimeoutError") {
        throw new ApiError(504, "Timed out waiting for OpenCode", "upstream_timeout", null, null, error)
      }
      throw new ApiError(502, `Could not connect to OpenCode at ${this.baseUrl}`, "upstream_error", null, null, error)
    }

    if (response.ok) return response
    const contentType = response.headers.get("content-type") || ""
    const body = contentType.includes("json") ? await response.json().catch(() => undefined) : await response.text()
    const status = response.status === 400 || response.status === 404 ? response.status : 502
    throw new ApiError(status, upstreamMessage(body, response.status), "upstream_error")
  }
}

function dateSeconds(value) {
  const milliseconds = typeof value === "string" ? Date.parse(value) : NaN
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : 0
}

export async function* parseSse(stream, signal) {
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of stream) {
    if (signal?.aborted) return
    buffer += decoder.decode(chunk, { stream: true })
    let boundary
    while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
      const block = buffer.slice(0, boundary.index)
      buffer = buffer.slice(boundary.index + boundary[0].length)
      const data = block
        .split(/\r\n|\n|\r/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
      if (!data || data === "[DONE]") continue
      try {
        yield JSON.parse(data)
      } catch {
        // Ignore malformed/heartbeat records; OpenCode events are independent.
      }
    }
  }
}
