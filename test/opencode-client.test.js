import test from "node:test"
import assert from "node:assert/strict"
import { parseSse } from "../src/opencode-client.js"

test("parses fragmented CRLF SSE records and ignores heartbeats", async () => {
  const encoder = new TextEncoder()
  const chunks = [
    "event: message\r\ndata: {\"type\":\"server.connected\"}\r\n\r",
    "\ndata: {\"type\":\"message.part.delta\",",
    "\"properties\":{\"delta\":\"hi\"}}\n\n: heartbeat\n\n",
  ]
  const stream = new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)))
      controller.close()
    },
  })

  const events = []
  for await (const event of parseSse(stream)) events.push(event)
  assert.deepEqual(events, [
    { type: "server.connected" },
    { type: "message.part.delta", properties: { delta: "hi" } },
  ])
})
