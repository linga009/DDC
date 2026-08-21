import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";

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

test("main.ts binds to 127.0.0.1 by default and discloses that authentication is required in its startup log", async () => {
  const env = { ...process.env, PORT: "0", SWARM_AUTH_TOKEN: "test-secret-token-1234" };
  delete env.HOST;

  const child = spawn(process.execPath, [mainPath], { env });
  try {
    const logLine = await waitForStartupLog(child);
    assert.match(logLine, /^coordinator listening on 127\.0\.0\.1:0 \(authentication required -- see SWARM_AUTH_TOKEN\)$/);
  } finally {
    child.kill();
  }
});

test("main.ts binds to the host given via the HOST env var", async () => {
  const env = { ...process.env, PORT: "0", HOST: "0.0.0.0", SWARM_AUTH_TOKEN: "test-secret-token-1234" };

  const child = spawn(process.execPath, [mainPath], { env });
  try {
    const logLine = await waitForStartupLog(child);
    assert.match(logLine, /^coordinator listening on 0\.0\.0\.0:0 \(authentication required -- see SWARM_AUTH_TOKEN\)$/);
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
  const env = { ...process.env, PORT: "0", HOST: "", SWARM_AUTH_TOKEN: "test-secret-token-1234" };

  const child = spawn(process.execPath, [mainPath], { env });
  try {
    const logLine = await waitForStartupLog(child);
    assert.match(logLine, /^coordinator listening on 127\.0\.0\.1:0 \(authentication required -- see SWARM_AUTH_TOKEN\)$/);
  } finally {
    child.kill();
  }
});

test("main.ts refuses to start when SWARM_AUTH_TOKEN is unset", async () => {
  const env = { ...process.env, PORT: "0" };
  delete env.SWARM_AUTH_TOKEN;

  const child = spawn(process.execPath, [mainPath], { env });
  const exitCode = await new Promise<number | null>(resolve => {
    child.on("exit", code => resolve(code));
  });
  assert.notEqual(exitCode, 0);
});

test("main.ts refuses to start when SWARM_AUTH_TOKEN is set but empty", async () => {
  const env = { ...process.env, PORT: "0", SWARM_AUTH_TOKEN: "" };

  const child = spawn(process.execPath, [mainPath], { env });
  const exitCode = await new Promise<number | null>(resolve => {
    child.on("exit", code => resolve(code));
  });
  assert.notEqual(exitCode, 0);
});

// A token carrying surrounding whitespace is worse than an unset one: the
// coordinator used to start, log a perfectly healthy "listening ...
// authentication required" line, and then 401 every request forever --
// including one sending the byte-exact configured token -- because Node's
// HTTP parser strips trailing whitespace off a received Authorization header,
// so the received value can never equal an authToken that still has it baked
// in. Verified live before the fix: SWARM_AUTH_TOKEN=$'tok\n' started fine and
// rejected everything, with nothing in the log to explain why.
for (const [label, token] of [
  ["a trailing newline (SWARM_AUTH_TOKEN=$(cat secret.txt))", "tok-with-newline\n"],
  ["a trailing space (a .env line with a stray space)", "tok-with-space "],
  ["a leading space", " tok-with-leading-space"],
  ["an embedded carriage return", "tok\rwith-cr"],
] as const) {
  test(`main.ts refuses to start when SWARM_AUTH_TOKEN has ${label}`, async () => {
    const env = { ...process.env, PORT: "0", SWARM_AUTH_TOKEN: token };

    const child = spawn(process.execPath, [mainPath], { env });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const exitCode = await new Promise<number | null>(resolve => {
      child.on("exit", code => resolve(code));
    });
    assert.notEqual(exitCode, 0);
    // The message has to actually name the problem -- an operator staring at
    // universal 401s needs to be pointed at their own token, not left to
    // guess.
    assert.match(stderr, /SWARM_AUTH_TOKEN must not contain leading\/trailing whitespace or newlines/);
  });
}

test("main.ts refuses to start when the safety rules file is malformed", async () => {
  const env = {
    ...process.env,
    PORT: "0",
    SWARM_AUTH_TOKEN: "test-secret-token-1234",
  };
  // This test intentionally does NOT override the real rules file path --
  // main.ts resolves coordinator/safety_rules.json relative to its own
  // module location, not an env var (see Task 1's Global Constraints note).
  // Instead this test temporarily corrupts the real file, restoring it
  // in a finally block no matter what.
  const rulesPath = fileURLToPath(new URL("../safety_rules.json", import.meta.url));
  const original = readFileSync(rulesPath, "utf-8");
  writeFileSync(rulesPath, "{ this is not valid json", "utf-8");

  try {
    const child = spawn(process.execPath, [mainPath], { env });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const exitCode = await new Promise<number | null>(resolve => {
      child.on("exit", code => resolve(code));
    });
    assert.notEqual(exitCode, 0);
    assert.match(stderr, /not valid JSON/);
  } finally {
    writeFileSync(rulesPath, original, "utf-8");
  }
});
