import { randomUUID } from "node:crypto"
import { ApiError } from "./errors.js"

const VALID_ROLES = new Set(["system", "developer", "user", "assistant", "tool", "function"])
const VALID_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"])

export function parseChatRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "Request body must be a JSON object")
  }
  if (typeof value.model !== "string" || !value.model.trim()) {
    throw new ApiError(400, "'model' is required and must be a string", "invalid_request_error", "model")
  }
  if (!Array.isArray(value.messages) || value.messages.length === 0) {
    throw new ApiError(400, "'messages' is required and must be a non-empty array", "invalid_request_error", "messages")
  }
  value.messages.forEach((message, index) => {
    if (!message || typeof message !== "object" || !VALID_ROLES.has(message.role)) {
      throw new ApiError(
        400,
        `messages[${index}].role is invalid`,
        "invalid_request_error",
        `messages.${index}.role`,
      )
    }
  })

  const tools = normalizeTools(value.tools)
  const effort = value.reasoning?.effort ?? value.reasoning_effort
  if (effort !== undefined && (!VALID_EFFORTS.has(effort) || typeof effort !== "string")) {
    throw new ApiError(
      400,
      "'reasoning_effort' (or 'reasoning.effort') must be one of none, minimal, low, medium, high, xhigh, or max",
      "invalid_request_error",
      "reasoning_effort",
    )
  }
  if (value.stream !== undefined && typeof value.stream !== "boolean") {
    throw new ApiError(400, "'stream' must be a boolean", "invalid_request_error", "stream")
  }
  if (
    value.tool_choice !== undefined &&
    typeof value.tool_choice !== "object" &&
    !["none", "auto", "required"].includes(value.tool_choice)
  ) {
    throw new ApiError(
      400,
      "'tool_choice' must be none, auto, required, or a named function choice",
      "invalid_request_error",
      "tool_choice",
    )
  }
  if (value.parallel_tool_calls !== undefined && typeof value.parallel_tool_calls !== "boolean") {
    throw new ApiError(
      400,
      "'parallel_tool_calls' must be a boolean",
      "invalid_request_error",
      "parallel_tool_calls",
    )
  }

  return {
    ...value,
    model: value.model.trim(),
    tools,
    effort,
    stream: value.stream === true,
    webFetch:
      tools.length === 0 &&
      (value.web_fetch === true ||
        value.enable_web_fetch === true ||
        (value.opencode && typeof value.opencode === "object" && value.opencode.web_fetch === true)),
  }
}

function normalizeTools(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new ApiError(400, "'tools' must be an array", "invalid_request_error", "tools")
  }
  const names = new Set()
  return value.map((tool, index) => {
    const fn = tool?.type === "function" ? tool.function : undefined
    if (!fn || typeof fn.name !== "string" || !fn.name.trim()) {
      throw new ApiError(
        400,
        `tools[${index}] must be a function tool with a name`,
        "invalid_request_error",
        `tools.${index}`,
      )
    }
    if (names.has(fn.name)) {
      throw new ApiError(400, `Duplicate tool name '${fn.name}'`, "invalid_request_error", `tools.${index}`)
    }
    names.add(fn.name)
    return {
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : "",
      parameters:
        fn.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters)
          ? fn.parameters
          : { type: "object", properties: {} },
    }
  })
}

export function parseModelName(model) {
  const separator = model.indexOf("/")
  if (separator <= 0 || separator === model.length - 1) {
    throw new ApiError(
      400,
      `Model '${model}' must use the provider/model format`,
      "invalid_request_error",
      "model",
      "model_not_found",
    )
  }
  return {
    providerID: model.slice(0, separator),
    modelID: model.slice(separator + 1),
  }
}

export function buildPrompt(request) {
  const systemMessages = request.messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => contentText(message.content))
    .filter(Boolean)

  const conversational = request.messages.filter(
    (message) => message.role !== "system" && message.role !== "developer",
  )
  const onlyUser =
    conversational.length === 1 &&
    conversational[0].role === "user" &&
    typeof conversational[0].content === "string"

  const text = onlyUser
    ? conversational[0].content
    : [
        "Continue the following OpenAI-format conversation. Preserve the roles and answer the latest message.",
        JSON.stringify(conversational),
      ].join("\n\n")

  const bridge = toolBridgeMode(request)
  const system = [
    ...systemMessages,
    "Act as the language model requested by the caller. Return only the assistant response; do not discuss this gateway.",
    bridge === "structured"
      ? [
          "External function tools are described by the required structured-output schema.",
          "You cannot execute those functions yourself. When a function is needed, return action=tool_calls with its exact name and JSON arguments.",
          "When no function is needed, return action=message with the final response in content.",
          "Never substitute an OpenCode built-in tool for an external function.",
        ].join(" ")
      : bridge === "prompt"
        ? promptToolBridgeInstructions(request)
        : undefined,
  ]
    .filter(Boolean)
    .join("\n\n")

  return {
    system,
    parts: [{ type: "text", text: text || "Continue." }],
    format: bridge === "structured" ? { type: "json_schema", schema: toolBridgeSchema(request) } : undefined,
  }
}

export function toolBridgeMode(request) {
  if (!request?.tools?.length || request.tool_choice === "none") return "none"
  const model = typeof request.model === "string" ? request.model.toLowerCase() : ""
  return /^opencode\/deepseek(?:[-/]|$)/.test(model) ? "prompt" : "structured"
}

function promptToolBridgeInstructions(request) {
  const tools = selectedTools(request).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: stripSchemaMeta(tool.parameters),
  }))
  const forced = request.tool_choice === "required" || typeof request.tool_choice === "object"
  const responseForms = forced
    ? ['{"action":"tool_calls","tool_calls":[{"name":"tool_name","arguments":{}}]}']
    : [
        '{"action":"message","content":"final assistant response"}',
        '{"action":"tool_calls","tool_calls":[{"name":"tool_name","arguments":{}}]}',
      ]

  return [
    "External function tools are available, but you cannot execute them yourself.",
    "Return exactly one JSON object with no Markdown fence and no text before or after it.",
    `Use one of these response forms: ${responseForms.join(" or ")}`,
    "Use action=tool_calls only when a function is needed. Use the exact function name and put its arguments in a JSON object.",
    forced ? "You must request at least one tool call." : "When no function is needed, use action=message.",
    "Never substitute an OpenCode built-in tool for an external function.",
    `Available external tools: ${JSON.stringify(tools)}`,
  ].join("\n")
}

function contentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content)
  return content
    .map((part) => {
      if (part?.type === "text" && typeof part.text === "string") return part.text
      if (part?.type === "image_url") {
        const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url
        return url ? `[image: ${url}]` : "[image]"
      }
      return JSON.stringify(part)
    })
    .join("\n")
}

function toolBridgeSchema(request) {
  const selected = selectedTools(request)
  const callSchemas = selected.map((tool) => ({
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", const: tool.name, description: tool.description || undefined },
      arguments: stripSchemaMeta(tool.parameters),
    },
    required: ["name", "arguments"],
  }))
  const callItem = callSchemas.length === 1 ? callSchemas[0] : { oneOf: callSchemas }
  const forced = request.tool_choice === "required" || typeof request.tool_choice === "object"

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: forced ? ["tool_calls"] : ["message", "tool_calls"],
        description: "Return message for a final answer, or tool_calls to ask the client to execute functions.",
      },
      content: { type: "string", description: "Final assistant text when action is message." },
      tool_calls: {
        type: "array",
        items: callItem,
        minItems: forced ? 1 : 0,
        maxItems: request.parallel_tool_calls === false ? 1 : undefined,
      },
    },
    required: forced ? ["action", "tool_calls"] : ["action"],
  }
}

function selectedTools(request) {
  const forced = request.tool_choice
  if (!forced || typeof forced !== "object") return request.tools
  const name = forced.type === "function" ? forced.function?.name : undefined
  if (typeof name !== "string" || !name) {
    throw new ApiError(400, "Invalid object value for 'tool_choice'", "invalid_request_error", "tool_choice")
  }
  const selected = request.tools.filter((tool) => tool.name === name)
  if (selected.length === 0) {
    throw new ApiError(400, `Tool choice '${name}' was not found in tools`, "invalid_request_error", "tool_choice")
  }
  return selected
}

function stripSchemaMeta(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { type: "object", properties: {} }
  const { $schema, ...schema } = value
  void $schema
  return schema
}

export function permissionsFor(request) {
  const rules = [{ permission: "*", pattern: "*", action: "deny" }]
  if (request.webFetch) rules.push({ permission: "webfetch", pattern: "*", action: "allow" })
  if (toolBridgeMode(request) === "structured") {
    rules.push({ permission: "StructuredOutput", pattern: "*", action: "allow" })
  }
  return rules
}

export function normalizeResult(result, request) {
  const info = result?.info ?? {}
  if (info.error) {
    const message = info.error?.data?.message ?? info.error?.message ?? JSON.stringify(info.error)
    throw new ApiError(502, message, "upstream_error")
  }

  const reasoning = (result?.parts ?? [])
    .filter((part) => part.type === "reasoning" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
  const text = (result?.parts ?? [])
    .filter((part) => part.type === "text" && !part.synthetic && typeof part.text === "string")
    .map((part) => part.text)
    .join("")

  const bridged =
    normalizeStructured(info.structured) ??
    (toolBridgeMode(request) === "prompt" ? parsePromptToolBridge(text, request) : undefined)
  if (bridged?.action === "tool_calls" && bridged.tool_calls.length > 0) {
    return {
      content: null,
      reasoning,
      toolCalls: bridged.tool_calls.map(openaiToolCall),
      finishReason: "tool_calls",
      usage: usage(info.tokens),
    }
  }
  return {
    content: bridged?.action === "message" ? bridged.content : text,
    reasoning,
    toolCalls: undefined,
    finishReason: finishReason(info.finish),
    usage: usage(info.tokens),
  }
}

export function normalizeStructured(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  if (value.action === "tool_calls" && Array.isArray(value.tool_calls)) {
    const toolCalls = value.tool_calls.filter(
      (call) => call && typeof call === "object" && typeof call.name === "string",
    )
    return { action: "tool_calls", tool_calls: toolCalls }
  }
  if (value.action === "message") {
    return { action: "message", content: typeof value.content === "string" ? value.content : "" }
  }
  return undefined
}

export function parsePromptToolBridge(text, request) {
  if (typeof text !== "string" || !text.trim()) return undefined
  const allowedTools = new Set(selectedTools(request).map((tool) => tool.name))
  for (const candidate of jsonObjectCandidates(text)) {
    let value
    try {
      value = JSON.parse(candidate)
    } catch {
      continue
    }
    const structured = normalizeStructured(value)
    if (!structured) continue
    if (structured.action === "message") return structured

    const toolCalls = structured.tool_calls
      .filter((call) => allowedTools.has(call.name))
      .map((call) => ({ ...call, arguments: normalizeToolArguments(call.arguments) }))
    if (toolCalls.length > 0) return { action: "tool_calls", tool_calls: toolCalls }
  }
  return undefined
}

function jsonObjectCandidates(text) {
  const candidates = [text.trim()]
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(match[1].trim())
  }

  let start = -1
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') {
      quoted = true
      continue
    }
    if (character === "{") {
      if (depth === 0) start = index
      depth += 1
    } else if (character === "}" && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, index + 1))
        start = -1
      }
    }
  }
  return [...new Set(candidates)]
}

function normalizeToolArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed
    } catch {
      // Invalid string arguments fall back to an empty object.
    }
  }
  return {}
}

export function openaiToolCall(call) {
  return {
    id: `call_${randomUUID().replaceAll("-", "")}`,
    type: "function",
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments ?? {}),
    },
  }
}

export function usage(tokens) {
  if (!tokens || typeof tokens !== "object") return undefined
  const prompt = number(tokens.input) + number(tokens.cache?.read) + number(tokens.cache?.write)
  const completion = number(tokens.output) + number(tokens.reasoning)
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: {
      cached_tokens: number(tokens.cache?.read),
    },
    completion_tokens_details: {
      reasoning_tokens: number(tokens.reasoning),
    },
  }
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

export function finishReason(value) {
  if (value === "length") return "length"
  if (value === "content-filter") return "content_filter"
  if (value === "tool-calls") return "tool_calls"
  return "stop"
}

export function completionBody({ id, created, model, result }) {
  const message = { role: "assistant", content: result.content }
  if (result.reasoning) message.reasoning_content = result.reasoning
  if (result.toolCalls) message.tool_calls = result.toolCalls
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, logprobs: null, finish_reason: result.finishReason }],
    usage: result.usage,
    system_fingerprint: null,
  }
}

export function chunkBody({ id, created, model, delta = {}, finishReason = null, usage: chunkUsage }) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
    ...(chunkUsage ? { usage: chunkUsage } : {}),
    system_fingerprint: null,
  }
}
