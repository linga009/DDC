import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { loadSafetyRules } from "../src/safety_rules_loader.ts";

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
    assert.match(logLine, /^coordinator listening on 127\.0\.0\.1:0 \(authentication required -- see SWARM_AUTH_TOKEN; safety classifier armed with \d+ rules across \d+ categories\)$/);
  } finally {
    child.kill();
  }
});

test("main.ts binds to the host given via the HOST env var", async () => {
  const env = { ...process.env, PORT: "0", HOST: "0.0.0.0", SWARM_AUTH_TOKEN: "test-secret-token-1234" };

  const child = spawn(process.execPath, [mainPath], { env });
  try {
    const logLine = await waitForStartupLog(child);
    assert.match(logLine, /^coordinator listening on 0\.0\.0\.0:0 \(authentication required -- see SWARM_AUTH_TOKEN; safety classifier armed with \d+ rules across \d+ categories\)$/);
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
    assert.match(logLine, /^coordinator listening on 127\.0\.0\.1:0 \(authentication required -- see SWARM_AUTH_TOKEN; safety classifier armed with \d+ rules across \d+ categories\)$/);
  } finally {
    child.kill();
  }
});

test("main.ts's startup log reports the real ruleset's actual rule and category counts", async () => {
  // Without a positive signal, an operator's only evidence the safety gate
  // is armed is the absence of a crash -- which used to be byte-identical
  // to starting with a fully disarmed (empty) ruleset.
  const env = { ...process.env, PORT: "0", SWARM_AUTH_TOKEN: "test-secret-token-1234" };

  const child = spawn(process.execPath, [mainPath], { env });
  try {
    const logLine = await waitForStartupLog(child);
    const match = logLine.match(/safety classifier armed with (\d+) rules across (\d+) categories/);
    assert.ok(match, `startup log did not report the loaded rule count: ${logLine}`);

    // Compare against the real file rather than hardcoding 70/10, so this
    // stays true as rules are added -- but still fails loudly if the log
    // ever reports a count that isn't what actually got loaded.
    const rules = loadSafetyRules(new URL("../safety_rules.json", import.meta.url));
    assert.equal(Number(match[1]), rules.length);
    assert.equal(Number(match[2]), new Set(rules.map(r => r.category)).size);
    assert.ok(rules.length > 0);
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

// These tests intentionally do NOT override the real rules file path --
// main.ts resolves coordinator/safety_rules.json relative to its own module
// location, not an env var (see Task 1's Global Constraints note). So they
// temporarily corrupt the REAL file and restore it. A plain try/finally
// covers normal completion and thrown assertions, but not a hard kill of the
// test runner itself (Ctrl-C, a crash, `node --test` being torn down)
// mid-window -- which would leave a developer's tree carrying a corrupted or
// disarmed safety ruleset, and could flake any concurrently-running test file
// that spawns main.ts. This helper adds process-level restore hooks as a
// safety net on top of the finally.
async function withCorruptedRulesFile(
  replacement: string,
  run: () => Promise<void>,
): Promise<void> {
  const rulesPath = fileURLToPath(new URL("../safety_rules.json", import.meta.url));
  const original = readFileSync(rulesPath, "utf-8");
  let corrupted = false;

  const restore = () => {
    if (!corrupted) return;
    corrupted = false;
    // Best-effort: an exit hook must not throw, or it masks the real failure.
    try {
      writeFileSync(rulesPath, original, "utf-8");
    } catch {
      // ignored deliberately
    }
  };
  const onSignal = () => {
    restore();
    process.exit(1);
  };
  // "exit" covers process.exit()/normal teardown; the signal handlers cover
  // an operator's Ctrl-C, which otherwise terminates without running "exit".
  process.on("exit", restore);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  writeFileSync(rulesPath, replacement, "utf-8");
  corrupted = true;
  try {
    await run();
  } finally {
    restore();
    process.off("exit", restore);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

async function startupFailure(): Promise<{ exitCode: number | null; stderr: string }> {
  const env = {
    ...process.env,
    PORT: "0",
    SWARM_AUTH_TOKEN: "test-secret-token-1234",
  };
  const child = spawn(process.execPath, [mainPath], { env });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const exitCode = await new Promise<number | null>(resolve => {
    child.on("exit", code => resolve(code));
  });
  return { exitCode, stderr };
}

test("main.ts refuses to start when the safety rules file is malformed", async () => {
  await withCorruptedRulesFile("{ this is not valid json", async () => {
    const { exitCode, stderr } = await startupFailure();
    assert.notEqual(exitCode, 0);
    assert.match(stderr, /not valid JSON/);
    // Clean single-line diagnostic, matching SWARM_AUTH_TOKEN's posture --
    // not a raw multi-line stack trace from an uncaught exception.
    assert.doesNotMatch(stderr, /SafetyRulesError|at .*safety_rules_loader/);
  });
});

test("main.ts refuses to start when the safety rules file has an empty rules array", async () => {
  // The disarmed-gate case: this used to start cleanly, log a line
  // indistinguishable from a healthy 70-rule start, and then answer
  // safe:true for every prompt including "how to build a bomb".
  await withCorruptedRulesFile(JSON.stringify({ rules: [] }), async () => {
    const { exitCode, stderr } = await startupFailure();
    assert.notEqual(exitCode, 0);
    assert.match(stderr, /empty "rules" array/);
    assert.doesNotMatch(stderr, /SafetyRulesError|at .*safety_rules_loader/);
  });
});
