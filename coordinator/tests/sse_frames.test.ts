import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { readSseFrames } from "../src/sse_frames.ts";

async function streamFromStub(write: (res: import("node:http").ServerResponse) => void): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const server = createHttpServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, { "content-type": "text/event-stream" });
    write(res);
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected stub server to bind a port");
  }
  const res = await fetch(`http://127.0.0.1:${address.port}/`, { method: "POST" });
  const reader = res.body!.getReader();
  // Server is closed once its response is fully buffered by the fetch --
  // acceptable for a same-process, localhost-only test stub.
  server.close();
  return reader;
}

test("readSseFrames yields one frame per data: line in order", async () => {
  const reader = await streamFromStub(res => {
    res.write("data: Paris\n\n");
    res.write("data:  is\n\n");
    res.write("data: [DONE]\n\n");
  });
  const frames = [];
  for await (const frame of readSseFrames(reader)) {
    frames.push(frame);
  }
  assert.deepEqual(frames, [{ event: undefined, data: "Paris" }, { event: undefined, data: " is" }]);
});

test("readSseFrames reconstructs a multi-line data: payload joined by newlines", async () => {
  const reader = await streamFromStub(res => {
    res.write("data: line one\ndata: line two\n\n");
    res.write("data: [DONE]\n\n");
  });
  const frames = [];
  for await (const frame of readSseFrames(reader)) {
    frames.push(frame);
  }
  assert.deepEqual(frames, [{ event: undefined, data: "line one\nline two" }]);
});

test("readSseFrames reports the event: field on a named event frame, and does not throw even though no [DONE] follows it", async () => {
  const reader = await streamFromStub(res => {
    res.write("data: partial\n\n");
    // Deliberately no [DONE] after this -- an error frame is itself a
    // legitimate terminal signal at the producer layer (see readSseFrames'
    // own doc comment), so the stream ending right here must NOT be
    // mistaken for a truncated connection.
    res.write('event: error\ndata: {"error":"boom"}\n\n');
  });
  const frames = [];
  for await (const frame of readSseFrames(reader)) {
    frames.push(frame);
  }
  assert.deepEqual(frames, [
    { event: undefined, data: "partial" },
    { event: "error", data: '{"error":"boom"}' },
  ]);
});

test("readSseFrames throws if the connection ends without [DONE] or an error frame", async () => {
  const reader = await streamFromStub(res => {
    res.write("data: partial\n\n");
    // Ends with neither [DONE] nor an event: error frame -- simulates a raw
    // connection drop (e.g. the node process was killed mid-generation),
    // which is otherwise indistinguishable from a clean, successful
    // end-of-stream.
  });
  const frames: unknown[] = [];
  await assert.rejects(
    async () => {
      for await (const frame of readSseFrames(reader)) {
        frames.push(frame);
      }
    },
    /\[DONE\]/,
  );
  assert.deepEqual(frames, [{ event: undefined, data: "partial" }]);
});

test("readSseFrames reports the event: field on a usage frame the same way", async () => {
  const reader = await streamFromStub(res => {
    res.write('event: usage\ndata: {"prompt_tokens":5,"completion_tokens":10,"finish_reason":"stop"}\n\n');
    res.write("data: [DONE]\n\n");
  });
  const frames = [];
  for await (const frame of readSseFrames(reader)) {
    frames.push(frame);
  }
  assert.deepEqual(frames, [
    { event: "usage", data: '{"prompt_tokens":5,"completion_tokens":10,"finish_reason":"stop"}' },
  ]);
});

test("readSseFrames stops at [DONE] without yielding it, even if more bytes somehow follow", async () => {
  const reader = await streamFromStub(res => {
    res.write("data: hi\n\n");
    res.write("data: [DONE]\n\n");
  });
  const frames = [];
  for await (const frame of readSseFrames(reader)) {
    frames.push(frame);
  }
  assert.deepEqual(frames, [{ event: undefined, data: "hi" }]);
});

test("readSseFrames on a stream that yields nothing but [DONE] produces zero frames", async () => {
  const reader = await streamFromStub(res => {
    res.write("data: [DONE]\n\n");
  });
  const frames = [];
  for await (const frame of readSseFrames(reader)) {
    frames.push(frame);
  }
  assert.deepEqual(frames, []);
});
