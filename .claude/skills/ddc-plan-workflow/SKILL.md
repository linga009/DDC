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
