export interface SseFrame {
  event?: string;
  data: string;
}

// Reads Server-Sent Events frames from `reader`, yielding one SseFrame per
// frame, in order, as they arrive -- does not buffer the whole stream
// first. Mirrors the parsing logic SwarmClient.generateStream()
// (coordinator/src/client.ts) already has, extracted here as a small,
// independently-testable, reusable piece for THIS process's own internal
// consumption of a node agent's SSE stream (a genuinely different use case
// from client.ts, which is the outward-facing SDK other processes use to
// talk to this coordinator -- see this plan's design doc for why they are
// not unified).
//
// Recognizes a data: payload of exactly "[DONE]" as the stream's own
// terminal sentinel: the generator returns (without yielding it) the
// moment it sees one. A frame with an "event: <name>" line reports that
// name via SseFrame.event; a plain data-only frame leaves it undefined. A
// multi-line data: payload (multiple consecutive "data: " lines in one
// frame, per the SSE spec's own multi-line convention) is joined with "\n"
// into SseFrame.data.
//
// Throws if the underlying stream ends WITHOUT ever seeing a [DONE]
// sentinel or an "event: error" frame -- mirroring the exact safety check
// client.ts's own generateStream() already has. The underlying HTTP
// response has no Content-Length (it's SSE, connection-delimited), so a
// node process dying mid-generation and a genuinely finished stream both
// report `done: true` from the reader with no other signal; without this
// check a truncated reply would be silently indistinguishable from a
// successfully completed one. An "event: error" frame counts as a
// legitimate terminal signal on its own -- core/src/http_server.cpp's
// ResponseWriter never sends [DONE] after an error frame (the two are
// code-enforced as mutually exclusive on the wire) -- so a stream ending
// right after one does NOT throw.
export async function* readSseFrames(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buffer = "";
  let sawTerminalSignal = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      if (!sawTerminalSignal) {
        throw new Error("readSseFrames: stream ended without a [DONE] terminator or an error frame -- the connection was likely lost mid-stream");
      }
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const lines = frame.split("\n");
      const eventLine = lines.find(line => line.startsWith("event: "));
      const event = eventLine ? eventLine.slice("event: ".length) : undefined;
      const dataLines = lines.filter(line => line.startsWith("data: "));
      if (dataLines.length === 0) {
        continue;
      }
      const data = dataLines.map(line => line.slice("data: ".length)).join("\n");
      if (data === "[DONE]") {
        sawTerminalSignal = true;
        return;
      }
      if (event === "error") {
        sawTerminalSignal = true;
      }
      yield { event, data };
    }
  }
}
