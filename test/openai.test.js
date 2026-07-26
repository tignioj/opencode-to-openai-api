import test from "node:test"
import assert from "node:assert/strict"
import {
  buildPrompt,
  completionBody,
  normalizeResult,
  parseChatRequest,
  parseModelName,
  parsePromptToolBridge,
  permissionsFor,
  toolBridgeMode,
} from "../src/openai.js"

test("parses provider/model using only the first slash", () => {
  assert.deepEqual(parseModelName("openrouter/openai/gpt-5"), {
    providerID: "openrouter",
    modelID: "openai/gpt-5",
  })
})

test("supports both reasoning effort spellings", () => {
  const base = { model: "opencode/big-pickle", messages: [{ role: "user", content: "hello" }] }
  assert.equal(parseChatRequest({ ...base, reasoning_effort: "high" }).effort, "high")
  assert.equal(parseChatRequest({ ...base, reasoning: { effort: "xhigh" } }).effort, "xhigh")
})

test("rejects unsupported tool choice values", () => {
  assert.throws(
    () =>
      parseChatRequest({
        model: "opencode/big-pickle",
        messages: [{ role: "user", content: "hello" }],
        tool_choice: "sometimes",
      }),
    /tool_choice/,
  )
})

test("disables every built-in tool by default", () => {
  const request = parseChatRequest({
    model: "opencode/big-pickle",
    messages: [{ role: "user", content: "hello" }],
  })
  assert.deepEqual(permissionsFor(request), [{ permission: "*", pattern: "*", action: "deny" }])
})

test("web fetch is only allowed without external tools and explicit opt-in", () => {
  const request = parseChatRequest({
    model: "opencode/big-pickle",
    messages: [{ role: "user", content: "fetch" }],
    opencode: { web_fetch: true },
  })
  assert.equal(request.webFetch, true)
  assert.deepEqual(permissionsFor(request).at(-1), {
    permission: "webfetch",
    pattern: "*",
    action: "allow",
  })
})

test("external tools use StructuredOutput and do not enable same-named built-ins", () => {
  const request = parseChatRequest({
    model: "opencode/big-pickle",
    messages: [{ role: "user", content: "fetch" }],
    tools: [
      {
        type: "function",
        function: {
          name: "web_fetch",
          parameters: {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"],
          },
        },
      },
    ],
  })
  const permissions = permissionsFor(request)
  assert.equal(permissions.some((rule) => rule.permission === "webfetch"), false)
  assert.equal(permissions.some((rule) => rule.permission === "StructuredOutput" && rule.action === "allow"), true)
  const prompt = buildPrompt(request)
  assert.equal(prompt.format.type, "json_schema")
  assert.match(JSON.stringify(prompt.format.schema), /web_fetch/)
})

test("OpenCode DeepSeek tools use prompt bridging without StructuredOutput", () => {
  const request = parseChatRequest({
    model: "opencode/deepseek-v4-flash-free",
    messages: [{ role: "user", content: "fetch" }],
    tools: [
      {
        type: "function",
        function: {
          name: "web_fetch",
          parameters: {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"],
          },
        },
      },
    ],
  })
  assert.equal(toolBridgeMode(request), "prompt")
  assert.equal(permissionsFor(request).some((rule) => rule.permission === "StructuredOutput"), false)
  const prompt = buildPrompt(request)
  assert.equal(prompt.format, undefined)
  assert.match(prompt.system, /Available external tools/)
  assert.match(prompt.system, /web_fetch/)
})

test("parses prompt-bridged DeepSeek tool calls and fenced JSON", () => {
  const request = parseChatRequest({
    model: "opencode/deepseek-v4-flash-free",
    messages: [{ role: "user", content: "weather" }],
    tools: [
      {
        type: "function",
        function: {
          name: "weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
    ],
  })
  assert.deepEqual(
    parsePromptToolBridge(
      '```json\n{"action":"tool_calls","tool_calls":[{"name":"weather","arguments":"{\\"city\\":\\"Shanghai\\"}"}]}\n```',
      request,
    ),
    {
      action: "tool_calls",
      tool_calls: [{ name: "weather", arguments: { city: "Shanghai" } }],
    },
  )
  assert.equal(
    parsePromptToolBridge(
      '{"action":"tool_calls","tool_calls":[{"name":"unknown","arguments":{}}]}',
      request,
    ),
    undefined,
  )
})

test("normalizes prompt-bridged DeepSeek messages", () => {
  const request = parseChatRequest({
    model: "opencode/deepseek-v4-flash-free",
    messages: [{ role: "user", content: "hello" }],
    tools: [
      {
        type: "function",
        function: { name: "noop", parameters: { type: "object", properties: {} } },
      },
    ],
  })
  const result = normalizeResult(
    {
      info: { finish: "stop" },
      parts: [{ type: "text", text: '{"action":"message","content":"hello"}' }],
    },
    request,
  )
  assert.equal(result.content, "hello")
  assert.equal(result.finishReason, "stop")
})

test("normalizes prompt-bridged DeepSeek tool calls", () => {
  const request = parseChatRequest({
    model: "opencode/deepseek-v4-flash-free",
    messages: [{ role: "user", content: "weather" }],
    tools: [
      {
        type: "function",
        function: { name: "weather", parameters: { type: "object", properties: {} } },
      },
    ],
  })
  const result = normalizeResult(
    {
      info: { finish: "stop" },
      parts: [
        {
          type: "text",
          text: '{"action":"tool_calls","tool_calls":[{"name":"weather","arguments":{"city":"Shanghai"}}]}',
        },
      ],
    },
    request,
  )
  assert.equal(result.content, null)
  assert.equal(result.finishReason, "tool_calls")
  assert.equal(result.toolCalls[0].function.name, "weather")
  assert.equal(result.toolCalls[0].function.arguments, '{"city":"Shanghai"}')
})

test("normalizes structured tool calls to OpenAI format", () => {
  const result = normalizeResult(
    {
      info: {
        finish: "stop",
        structured: {
          action: "tool_calls",
          tool_calls: [{ name: "weather", arguments: { city: "Shanghai" } }],
        },
        tokens: { input: 5, output: 2, reasoning: 1, cache: { read: 3, write: 0 } },
      },
      parts: [],
    },
    {},
  )
  assert.equal(result.finishReason, "tool_calls")
  assert.equal(result.toolCalls[0].function.name, "weather")
  assert.equal(result.toolCalls[0].function.arguments, '{"city":"Shanghai"}')
  assert.equal(result.usage.total_tokens, 11)
  const body = completionBody({
    id: "chatcmpl-test",
    created: 1,
    model: "test/model",
    result,
  })
  assert.equal(body.choices[0].message.content, null)
  assert.equal(body.choices[0].finish_reason, "tool_calls")
})
