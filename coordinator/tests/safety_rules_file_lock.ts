import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
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
//
// Fifth whole-branch review, Minor finding: only a WRITER of the real file
// (this module exists specifically for withCorruptedRulesFile's temporary
// corruption) and a reader that could otherwise race a writer from a
// DIFFERENT test file need this lock -- two readers never conflict with
// each other, and node:test's own default execution model already
// serializes every test within one file, so a reader in the SAME file as
// the writer needs no extra coordination. Concretely: every test in
// main.test.ts other than the two that call withCorruptedRulesFile reads
// or spawns against the REAL, uncorrupted file and does not need this
// lock; safety_rules_loader.test.ts's "the real shipped ruleset" tests
// acquire it because they are exactly the cross-file readers the original
// flake was caught racing against a write.
const LOCK_DIR = join(tmpdir(), "ddc-coordinator-safety-rules-file.lock");
const MARKER_PATH = join(LOCK_DIR, "acquired-at");
const POLL_MS = 25;
const TIMEOUT_MS = 15000;
// Fifth whole-branch review, Minor finding, fixed here: without staleness
// detection, a holder that died without running its exit hook (a hard
// kill, an OOM, a CI runner tearing a worker down mid-test) left LOCK_DIR
// behind forever -- live-reproduced: every subsequent `npm test` then
// failed 5 tests with the timeout error below, requiring a human to find
// and delete a directory in the OS temp dir. Every legitimate hold of this
// lock in this file's own tests completes in well under a second, so a
// lock still standing after a full minute cannot be a slow-but-alive
// holder -- it's abandoned. Checked BEFORE this call's own TIMEOUT_MS
// deadline, and reclaimed on the spot regardless of how long THIS caller
// has been waiting, rather than waiting out the full deadline just to
// throw the same diagnostic anyway.
//
// Sixth whole-branch review, Minor finding, disclosed rather than
// engineered around here (test-infrastructure only, no production code
// touches this file): this reclaim has no fencing token, so a genuine
// holder that somehow ran past STALE_MS (not plausible today -- every
// hold in this file's own tests completes in well under a second) could
// have its lock stolen by a reclaimer and then, on release, delete
// whatever the new holder had since created. A crash landing in the
// narrow window between mkdirSync and the marker write below also leaves
// a lock with no marker, which reads as "indeterminate" (never stale),
// not reclaimable until deleted by hand. Both are real but narrow; worth
// a real fencing token (a unique id written and re-checked before
// deleting) if this pattern is ever reused for anything higher-stakes.
const STALE_MS = 60000;

function lockAgeMs(): number | undefined {
  try {
    const acquiredAt = Number(readFileSync(MARKER_PATH, "utf-8"));
    return Number.isFinite(acquiredAt) ? Date.now() - acquiredAt : undefined;
  } catch {
    return undefined; // dir exists but the marker doesn't (yet) -- indeterminate, not stale
  }
}

// Runs `fn` with exclusive access to the real safety_rules.json file.
// Every WRITER must acquire this first, and so must any reader in a
// DIFFERENT test file than the writer (see the module comment above for
// why a same-file reader doesn't need to). Released even if `fn` throws.
export async function withRealSafetyRulesFileLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      writeFileSync(MARKER_PATH, String(Date.now()), "utf-8");
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      const age = lockAgeMs();
      if (age !== undefined && age > STALE_MS) {
        try {
          rmSync(LOCK_DIR, { recursive: true, force: true });
        } catch {
          // Raced with another reclaimer -- just retry the loop.
        }
        continue;
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
      // recursive: the directory now also holds the staleness marker
      // file, so a plain rmdirSync (empty-directories only) would fail.
      rmSync(LOCK_DIR, { recursive: true, force: true });
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
