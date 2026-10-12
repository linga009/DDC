---
name: ddc-plan-workflow
description: Use when starting, resuming, or reviewing a DDC (swarm-llm distributed inference) implementation plan in this repo — grounds the generic writing-plans/subagent-driven-development skills in this project's specific conventions (worktree layout, model tiers, live-probing requirement, no-trailer rule, doc-update-after-push rule).
---

# DDC Plan Workflow

This project (see `CLAUDE.md` at repo root) is built plan-by-plan against
`docs/superpowers/specs/2026-08-14-distributed-llm-inference-design.md`,
using the generic superpowers skills — **brainstorming, writing-plans,
subagent-driven-development, finishing-a-development-branch,
using-git-worktrees**. This skill does not replace those; it fills in the
DDC-specific defaults they leave open, so a fresh session doesn't have to
rediscover them.

**Announce at start:** "I'm using the ddc-plan-workflow skill to [scope /
resume / review] this plan."

## Before Scoping a New Plan

1. Read `CLAUDE.md`'s Plan Roadmap table for what's done, in progress, and
   not yet designed.
2. Read the master spec's relevant section fresh — do not rely on memory of
   what it says, it has been corrected in place before (see its dated
   correction notes, e.g. the MoE per-expert placement infeasibility note
   added during Plan 4).
3. **Read the actual current state of every file the new plan will touch**
   before writing task code — `coordinator/src/registry.ts`,
   `coordinator/src/server.ts`, etc. have all been modified by every prior
   plan's fix rounds. A plan written against remembered signatures instead
   of current ones is the single most common source of implementer
   confusion in this project's history.
4. If the spec's prose implies infrastructure this repo doesn't have yet
   (most commonly: real multi-hop request routing / pipeline assembly —
   see `CLAUDE.md`'s closing note, still true as of Plan 9), say so
   explicitly in the plan's own text, the way every plan since Plan 6 has
   done in a "Scope correction" or "What this plan does not do" section.
   This is correct scoping, not a shortfall to apologize for.

## Resuming a Written-But-Unexecuted Plan

A plan can be fully written, self-reviewed, and pushed with zero
implementation tasks started — the session ended (or the user paused
deliberately) between "plan approved" and "worktree created." Check
`CLAUDE.md`'s Plan Roadmap table for a status like "plan written,
implementation paused" before assuming a plan needs scoping from scratch.

- **Do not re-scope or rewrite the plan** just because time has passed —
  the plan doc is the authority on what to build; re-read it, don't
  second-guess it, unless re-grounding (next bullet) reveals it's actually
  gone stale against the code.
- **Re-ground against current file state before dispatching Task 1's
  implementer**, even though the plan was written against "current" state
  recently — other work may have landed on `master` since, and this
  project's own history (see Common Mistakes below) is full of plans that
  drifted from the files they described within the same session, let alone
  across a gap. If a "Find" block in the plan's first task no longer
  matches the real file, that's a signal to re-verify the rest of the plan
  before proceeding, not just patch that one spot.
- **No worktree exists yet for an unexecuted plan** — create it fresh per
  `using-git-worktrees`/the Task Dispatch Defaults below, don't look for
  one left over from the planning session.
- Proceed straight into `subagent-driven-development` at the plan's first
  task — a written-and-approved plan does not need another round of user
  sign-off to begin execution, unless the user's own pause instruction said
  otherwise.

## Resuming a Plan Paused Mid-Review-Cycle

Distinct from an unexecuted plan (above): implementation is done, one or
more fix rounds have already been applied and committed to the worktree
branch, but whole-branch review has not yet come back clean — the user
paused deliberately (e.g. "good enough for this weekend") rather than
letting the review→fix→re-review loop run to convergence. Check
`CLAUDE.md`'s own per-phase paragraph for language like "paused here,
mid-review-cycle... not because review converged" before assuming a phase
with lots of commits and passing tests is close to done.

- **Do not treat "many review rounds already happened" as evidence the
  branch is nearly clean.** This project's own history (Phase C: 3 rounds;
  Endpoint Identity Hardening: 7 rounds, 6 of which found a real issue) is
  the opposite signal — a security/concurrency-sensitive coordinator
  branch that has needed several rounds tends to need another one, not
  fewer. Read the CLAUDE.md paragraph for the LAST round's actual findings
  before assuming anything about the current state.
- **The explicit next step is another whole-branch review**, not a docs
  pass or a merge — re-read this skill's own live-adversarial-probing
  requirement below and dispatch it before writing any more code, unless
  the user has asked for something else specifically. **But if the last
  two rounds each found a regression, do not just dispatch another
  read-through round: brief the reviewer to BUILD OR EXTEND AN EXECUTABLE
  INVARIANT HARNESS** (see "Common Mistakes" below). Endpoint Identity
  Hardening needed 9 rounds; the ninth, which built a harness instead of
  reading, found in seconds what the first eight missed.
- **Do not merge** a phase whose CLAUDE.md paragraph says it's paused
  mid-cycle, even if all tests currently pass — passing tests has not
  once, across this project's history, been sufficient evidence a
  concurrency-sensitive branch is done; only a review round that
  genuinely finds nothing has been.

## Task Dispatch Defaults for This Repo

- **Worktree location:** `.worktrees/<plan-name>`, branch name matches.
  After `cd`-ing into it for any exploration, `cd` back to the repo root
  before finishing — Windows locks a process's current directory, and a
  stray shell (yours or a background task you forgot about) left inside a
  worktree will block `git worktree remove` with a cryptic "Device or
  resource busy" error. If that happens: `Get-CimInstance Win32_Process |
  Where-Object { $_.ExecutablePath -match 'bash|node' }` to find the
  culprit, kill it, retry.
- **Model tiers** (per `subagent-driven-development`'s Model Selection,
  applied concretely for this repo):
  - Coordinator task with the plan's exact code already given (transcription
    + testing) → cheapest tier (haiku).
  - Coordinator task requiring reading current file state and integrating
    across 2+ files → standard tier (sonnet).
  - Whole-branch review, and any C++ task touching llama.cpp integration or
    member-ownership/lifetime reasoning → most capable tier (opus).
- **Coordinator (Node.js/HTTP) plans' whole-branch review must include live
  adversarial probing** — dispatch it with instructions to start the real
  server (import `createServer` directly, drive it with real `fetch`
  calls, matching `coordinator/tests/server.test.ts`'s own
  `startTestServer` pattern) and adversarially probe new endpoints/fields,
  not just read the diff. This project's bug history (see `CLAUDE.md`) is
  a checklist of what reading-only review has missed before: malformed/
  reserved-name inputs (`__proto__`, `constructor`), repeated-identical-call
  state leaks, cross-endpoint filtering consistency (e.g. does a new
  ejection/exclusion mechanism apply everywhere an old one already does?),
  concurrency/interleaving, and federation round-trips when the change
  touches anything `fetchPeerCapacity` or `/capacity` reads.
- **C++ plans:** reuse the ccache dir and local llama.cpp mirror named in
  `CLAUDE.md` rather than cold-cloning; double-check member declaration
  order (backing storage before `model_`/`ctx_`) in any new
  `InferenceEngine` constructor overload or member addition.
- **Every implementer and fix-subagent dispatch prompt must explicitly
  state**: "do NOT add a Co-Authored-By trailer to any commit" — this does
  not carry over automatically between dispatches.

- **The pipeline state machine has a standing oracle** (it lives on the
  `endpoint-identity-hardening` branch until that merges, so check it
  exists in your checkout):
  `coordinator/tests/pipeline_state_machine.test.ts` (randomized
  interleavings over the real `createServer()` handler and the real
  `PipelinePoolManager`, invariants checked after every step). After ANY
  change to `server.ts`'s cold-start assembly (`ensurePipelineReady` /
  `assemblePipeline`) or to `pipeline_pool_manager.ts`, run it scaled up —
  `STATE_MACHINE_SEED_SCALE=40 npm test` — before trusting a review or
  merging; a failure prints the seed and the call to reproduce it. If a
  change adds a new way a launcher, pipeline or driver registration can be
  created, retired or routed to, add the matching invariant to the harness
  in the same change.

## After Merge

1. Verify tests on `master` after the merge (not just on the branch).
2. Update `CLAUDE.md`'s Plan Roadmap table (status column) and `README.md`
   (new endpoints/interfaces, new caveats/gaming-vectors disclosed) to
   reflect what just landed.
3. Commit those doc updates and push — in the same session, before moving
   to the next plan. Don't let a completed plan's docs lag behind its code.
4. Remove the worktree and delete the merged branch (see
   `finishing-a-development-branch`'s cleanup steps) before starting the
   next plan's worktree.

## Common Mistakes (from this project's actual history)

- Writing a plan's test code from memory of a class's shape instead of
  reading the current file — has caused implementer confusion multiple
  times (e.g. a heartbeat-revival regression in Plan 6 traced back to
  timing math the plan itself got wrong, not the implementer).
- Forgetting a new filtering/exclusion mechanism (reputation, locality)
  needs to be threaded through *every* existing read path that already
  filters on an older mechanism (`GET /nodes`, `GET /capacity`, `/catalog`'s
  aggregation, and now `GET /nodes/locality`) — Plan 8's whole-branch
  review caught exactly one such miss (`GET /capacity` not yet reputation-
  filtered) after the task-level review had already approved the task.
- Treating a plan-author-supplied example code snippet as unreviewable —
  the `__proto__`-key bug in Plan 9 originated in the plan brief's own
  suggested code and shipped through task-level review; only the
  live-probing whole-branch review caught it. Suggested code in a brief is
  a starting point, not a guarantee.
- Fixing a TOCTOU (time-of-check-to-time-of-use) race, or a latency
  problem caused by an awaited call on a hot path, by patching the ONE
  spot the finding pointed at, instead of restating the actual rule and
  checking every place it applies. Endpoint Identity Hardening hit this
  shape five separate times across its 7 review rounds: a collision-check
  re-added before one `await` but not a sibling variable spanning the
  same `await`; a detached "don't block the caller" fix that left
  state-machine bookkeeping (a reservation's `state`) stuck in a way a
  DIFFERENT, unrelated gate then misread; a newly-added verified-identity
  tracking set that recorded writes from one code path but not a second,
  equally-trusted writer. Each was a real regression a genuinely
  independent whole-branch review caught, not a missed edge case in the
  same review. When fixing this class of bug, explicitly ask "what ELSE
  reads or writes this same state, across an `await` or a detach point,
  that this fix doesn't touch" before considering it done.
- Reviewing a CONCURRENT state machine by reading diffs, round after round.
  Endpoint Identity Hardening's first eight rounds each read a change and
  seven found a real bug (several introduced by the previous round's own
  fix); the ninth built a deterministic randomized interleaving harness
  and found five violations in seconds — including a request answered `200`
  with another model's weights that reproduces on `master`. Code with
  shared mutable state and check-then-act across `await`s cannot be judged
  by reading: each patch fixes the instance the reviewer happened to see.
  When a second round in a row finds a regression, switch methods. Rules
  that came out of doing it:
  - **Verify the harness as a DETECTOR before trusting its green.** Run it
    against the pre-fix source in a scratch copy (`git archive HEAD … | tar
    -x`) and require it to fail on the original seeds. Reverting ONE fix at
    a time is a weak test — overlapping fixes (defense in depth) mask each
    other — so fixed-seed "anchor" tests are weak guards and the targeted
    unit tests are the real regression guards.
  - **Mutation-check with a NO-OP CONTROL mutation.** An early checker
    silently mis-parsed its output (Python decoded `ℹ` with the Windows
    codepage) and reported every test "not caught"; only the control
    exposed it. Mutation-check your own tests as well: two were blind (a
    clock that never advanced during the tick; a guard made redundant by a
    stronger one), and one mutation run exposed a real ordering bug in the
    fix itself (deregistering a driver BEFORE checking the entry still held
    its launcher could remove a new pipeline's registration at the same
    endpoint).
  - **When the harness flags something, prove from a replayed seed whether
    the PRODUCT or the CHECKER is wrong, and write the reasoning down.**
    Two checker invariants did need correcting (routable must honour the
    driver-endpoint binding; the cap is routable-warm, not warm+assembling)
    — but "fix the failing checker" is also exactly how a real bug gets
    hidden.
  - **A green sweep is evidence only on seeds you did not tune against.**
    Hold out fresh seed ranges for the final run (here: 13,000, zero
    violations, after earlier ~10,000-seed batches had each driven a fix).
  - **Expect the oracle to widen scope.** It surfaced pre-existing Phase B/C
    defects, not just the phase's own; surface that scope question to the
    user rather than quietly absorbing or ignoring it.
  - **Test hygiene can silently cost minutes:** a stub gate held open for
    the whole test left the coordinator's detached `DELETE` fetches pinned
    to 60-second abort timers, so node could not exit — one file went from
    ~13s to ~82s. Release gates in `finally`.
