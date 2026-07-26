import test from "node:test"
import assert from "node:assert/strict"
import {
  buildPrompt,
  completionBody,
  normalizeResult,
  parseChatRequest,
  parseModelName,
  permissionsFor,
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
