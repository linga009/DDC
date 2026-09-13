import { mkdirSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fourth whole-branch review of the endpoint-identity-hardening branch,
// Important finding, fixed here: main.test.ts's withCorruptedRulesFile()
// temporarily overwrites the REAL coordinator/safety_rules.json on disk
// (main.ts resolves that path relative to its own module location, not an
// env var -- a deliberate Global Constraint from the safety-classifier
// ruleset plan, matching SWARM_AUTH_TOKEN's fixed-location posture, so
// test code cannot just point main.ts at a temp copy instead). Meanwhile
// safety_rules_loader.test.ts's own "the real shipped ruleset" tests read
// that exact same file directly. `node --test` isolates each test FILE in
// its own OS process by default, so an in-memory JS lock cannot coordinate
// between them -- only the filesystem can. Without this, running the full
// suite hits a real, reproducible window where a read lands mid-corruption
// and fails with "not valid JSON", even though the file is always restored
// correctly afterward and every individual test file passes in isolation.
//
// A directory create is atomic and fails with EEXIST if it already
// exists -- a zero-dependency mutex using only what's already on this
// project's permitted-module list. Lives in the OS temp dir, never next to
// the rules file itself, so it's never mistaken for project state and
// never needs gitignoring.
const LOCK_DIR = join(tmpdir(), "ddc-coordinator-safety-rules-file.lock");
const POLL_MS = 25;
const TIMEOUT_MS = 15000;

// Runs `fn` with exclusive access to the real safety_rules.json file --
// every reader or writer of that real file, across every test file, must
// acquire this same lock first. Released even if `fn` throws.
export async function withRealSafetyRulesFileLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out after ${TIMEOUT_MS}ms waiting for the real safety_rules.json file lock (${LOCK_DIR}) -- a previous test run may have crashed while holding it; delete that directory manually if so`);
      }
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
  }
  // A hard kill (Ctrl-C, a crash, `node --test` being torn down) while this
  // lock is held would otherwise leave LOCK_DIR behind forever, hanging
  // every subsequent test run for the full TIMEOUT_MS -- same class of
  // problem withCorruptedRulesFile's own restore-on-exit hooks exist for,
  // so this mirrors that pattern rather than introducing a different one.
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      rmdirSync(LOCK_DIR);
    } catch {
      // ignored deliberately -- an exit hook must not throw
    }
  };
  const onSignal = () => {
    release();
    process.exit(1);
  };
  process.on("exit", release);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    return await fn();
  } finally {
    release();
    process.off("exit", release);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
