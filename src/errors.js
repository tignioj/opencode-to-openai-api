export class ApiError extends Error {
  constructor(status, message, type = "invalid_request_error", param = null, code = null, cause) {
    super(message, { cause })
    this.name = "ApiError"
    this.status = status
    this.type = type
    this.param = param
    this.code = code
  }
}

export function errorBody(error) {
  const apiError =
    error instanceof ApiError
      ? error
      : new ApiError(500, error instanceof Error ? error.message : String(error), "server_error")
  return {
    error: {
      message: apiError.message,
      type: apiError.type,
      param: apiError.param,
      code: apiError.code,
    },
  }
}

export function upstreamMessage(body, status) {
  if (typeof body === "string" && body.trim()) return body.trim()
  if (!body || typeof body !== "object") return `OpenCode returned HTTP ${status}`
  if (typeof body.message === "string") return body.message
  if (typeof body.error === "string") return body.error
  if (body.error && typeof body.error.message === "string") return body.error.message
  return `OpenCode returned HTTP ${status}`
}
