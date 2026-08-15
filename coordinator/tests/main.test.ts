import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(new URL("../src/main.ts", import.meta.url));

// main.ts runs at import time (it's the process entry point, not a library
// module), so the cleanest way to verify its startup behavior without
// binding a real listener in-process is to spawn it as a subprocess and
// read its startup log line, the same way server.test.ts exercises real
// server behavior over real sockets rather than mocking anything.
function waitForStartupLog(child: ReturnType<typeof spawn>, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for coordinator startup log; output so far: ${buffer}`));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(/coordinator listening on [^\n]+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

test("main.ts binds to 127.0.0.1 by default and discloses the no-auth caveat in its startup log", async () => {
  const env = { ...process.env, PORT: "0" };
  delete env.HOST;

  const child = spawn(process.execPath, [mainPath], { env });
  try {
    const logLine = await waitForStartupLog(child);
    assert.match(logLine, /^coordinator listening on 127\.0\.0\.1:0 \(no authentication -- trusted networks only\)$/);
  } finally {
    child.kill();
  }
});

test("main.ts binds to the host given via the HOST env var", async () => {
  const env = { ...process.env, PORT: "0", HOST: "0.0.0.0" };

  const child = spawn(process.execPath, [mainPath], { env });
  try {
    const logLine = await waitForStartupLog(child);
    assert.match(logLine, /^coordinator listening on 0\.0\.0\.0:0 \(no authentication -- trusted networks only\)$/);
  } finally {
    child.kill();
  }
});

test("main.ts falls back to 127.0.0.1 when HOST is set but empty, not all interfaces", async () => {
  // HOST="" is set-but-empty, distinct from HOST being unset. A `??`
  // fallback only triggers on `undefined`, so it would let "" through and
  // an empty string passed to server.listen() binds to all interfaces
  // (0.0.0.0 and ::) -- silently defeating the safe-default fix. Only a
  // falsy-string check (`||`, or an explicit `=== ""` check) catches this.
  const env = { ...process.env, PORT: "0", HOST: "" };

  const child = spawn(process.execPath, [mainPath], { env });
  try {
    const logLine = await waitForStartupLog(child);
    assert.match(logLine, /^coordinator listening on 127\.0\.0\.1:0 \(no authentication -- trusted networks only\)$/);
  } finally {
    child.kill();
  }
});
