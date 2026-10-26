import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readAIStream } from '../src/services/api'

function stream(chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }))
}

test('AI stream buffers partial JSON lines and finishes at done', async () => {
  const updates: string[] = []
  const result = await readAIStream(stream(['data: {"te', 'xt":"第一段"}\n', 'data: {"text":"第二段"}\ndata: {"done":true}\n']),
    value => updates.push(value), new AbortController().signal)
  assert.equal(result, '第一段第二段')
  assert.deepEqual(updates, ['第一段', '第一段第二段'])
})

test('AI stream handles an unterminated final line on EOF', async () => {
  const result = await readAIStream(stream(['data: {"text":"完整结果"}']), () => {}, new AbortController().signal)
  assert.equal(result, '完整结果')
})

test('AI stream reports server errors rather than hanging in streaming state', async () => {
  await assert.rejects(readAIStream(stream(['data: {"error":"synthetic failure"}\n']), () => {}, new AbortController().signal), /synthetic failure/)
})

test('cancelled AI stream cannot deliver text into another task', async () => {
  const controller = new AbortController()
  controller.abort()
  let called = false
  await assert.rejects(readAIStream(stream(['data: {"text":"old task"}\n']), () => { called = true }, controller.signal), { name: 'AbortError' })
  assert.equal(called, false)
})
