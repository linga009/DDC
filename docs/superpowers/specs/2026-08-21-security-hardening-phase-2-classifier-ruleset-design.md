# Security & Trust Hardening — Phase 2: Real Safety-Classifier Ruleset — Design

## Background: the four-phase initiative

This is Phase 2 of the Security & Trust Hardening initiative (see
`CLAUDE.md`'s Plan Roadmap). Phase 1 (shared-secret authentication,
`SWARM_AUTH_TOKEN`) is done and merged. Phase 2 replaces the coordinator's
zero-rule default `KeywordSafetyClassifier` with a real, curated ruleset.
Phases 3 (sybil-resistant reputation) and 4 (reputation-ranked node
selection) remain unstarted and undesigned.

## Goals

- Give `POST /classify` and `POST /generate`'s safety gate a real,
  non-empty ruleset covering a broad set of harm categories, so both
  endpoints stop reporting `safe: true` for every prompt by default.
- Make the ruleset editable without a code change (a config file, not
  hardcoded TypeScript).
- Fail fast at coordinator startup on any malformed rule or ruleset file —
  matching Phase 1's `SWARM_AUTH_TOKEN` precedent — rather than silently
  falling back to a degraded (or empty) ruleset.
- Zero new dependencies, matching this project's existing constraint for
  the coordinator.

## Non-Goals

- **Semantic/model-backed classification.** This is a pattern-matching
  ruleset, not a real content-understanding system. It cannot catch
  rephrased, misspelled, translated, or novel harmful prompts — only
  prompts that contain one of the configured terms/patterns. A
  model-backed classifier (calling a real model via the C++
  `InferenceEngine`/a `swarm-node-agent`) was explicitly considered and
  rejected for this phase: it's a much larger scope (no existing bridge
  from the coordinator to local inference for this purpose, and
  `server.ts`'s 2-second classify timeout is tight for real LLM
  inference) — deferred as a possible separate, future initiative, not
  folded into "Phase 2" as currently scoped.
- **Changing `KeywordSafetyClassifier` itself.** It already accepts
  arbitrary `KeywordRule[]` with correct, stateless regex handling
  (including the historical `lastIndex`-mutation fix). This phase changes
  only what rules it's constructed with and how those rules are authored.
- **Runtime rule reloading.** The ruleset is fixed for a process's
  lifetime, loaded once at startup. Changing rules requires a restart —
  consistent with how `SWARM_AUTH_TOKEN` already works, and simpler than
  building a reload/watch mechanism this phase doesn't need.
- **Exhaustive category coverage.** The 10 categories below are a
  reasonable initial set, not a claim of completeness. Adding a category
  later is a JSON file edit, not a redesign.

## Architecture

### Rule file: `coordinator/safety_rules.json`

Sits alongside `src/`, `tests/`, `public/`, and `package.json` — this is
configuration data, not source code or a browser-served asset, so it
doesn't belong in either `src/` or `public/`.

Shape:

```json
{
  "rules": [
    { "category": "violence_and_weapons", "term": "some phrase" },
    { "category": "violence_and_weapons", "pattern": "raw\\s*regex\\s*source" }
  ]
}
```

Every rule has a `category` (non-empty string) and **exactly one** of:
- `term` — a plain word/phrase. The loader wraps it in word boundaries
  (`\b`) and compiles it case-insensitively. This is the path most rules
  should use.
- `pattern` — a raw regex source string, compiled case-insensitively and
  used as-is (no automatic word-boundary wrapping). An escape hatch for
  the rare rule that genuinely needs something `\b`-wrapping can't express
  (e.g. a pattern spanning a variable number of words, or one that
  deliberately matches inside a larger word).

10 initial categories: `violence_and_weapons`, `csam`, `self_harm`,
`illegal_drugs`, `hate_speech_and_extremism`, `harassment`,
`fraud_and_scams`, `malware_and_hacking`, `adult_sexual_content`,
`misinformation_and_election_interference`. The actual rule content
(specific terms/patterns per category) is authored in the implementation
plan, not this design doc — a design doc doesn't carry data payloads, and
"no placeholders" means the plan has to contain real content anyway.

### Loader: `coordinator/src/safety_rules_loader.ts` (new)

One function, roughly:

```typescript
function loadSafetyRules(filePath: string): KeywordRule[]
```

Reads the file, `JSON.parse`s it, and validates:
- the file exists and is readable
- the parsed JSON has a `rules` array
- every entry has a non-empty `category`
- every entry has **exactly one** of `term`/`pattern` (neither or both is
  an error)
- every `pattern` entry's regex source actually compiles (`new RegExp(...)`
  doesn't throw)

Any failure throws a `SafetyRulesError` (or similar) with a message naming
the specific problem (which file, which rule index, what's wrong) — this
is what `main.ts` lets propagate into a fail-fast exit, so the message is
what an operator sees on stderr.

On success, returns `KeywordRule[]` — `term` entries transformed into
`{ category, pattern: /\btermsource\b/i }`, `pattern` entries transformed
into `{ category, pattern: new RegExp(source, "i") }`. This return type is
`KeywordSafetyClassifier`'s existing constructor input, unchanged.

### `coordinator/src/main.ts`

```typescript
const rules = loadSafetyRules(new URL("../safety_rules.json", import.meta.url).pathname);
const classifier = new KeywordSafetyClassifier(rules);
```

placed right alongside the existing `SWARM_AUTH_TOKEN` fail-fast check — an
uncaught throw from `loadSafetyRules` means the process exits non-zero
before ever binding a port, exactly like an unset token does today.

### `server.ts`, `client.ts`, dashboard

Untouched. `POST /classify` and `POST /generate` already call
`classifier.classify(prompt)` through the existing 2-second timeout,
fail-closed wrapper — that code doesn't know or care whether the
classifier has 0 rules or 200.

## Open Questions

- **Regex authoring safety (ReDoS).** A hand-authored `pattern` rule could
  in principle be catastrophically backtracking. This project doesn't
  currently have any regex-complexity linting, and adding one is out of
  scope for this phase — worth a one-line README/comment warning to future
  rule authors, not a technical control.
- **Multi-language coverage.** All 10 categories' initial content will
  most likely be English-only. Non-English harmful prompts will pass
  through unfiltered. Named here so it's not silently assumed to be
  covered.

## Testing Considerations

- `safety_rules_loader.test.ts`: valid file → correct `KeywordRule[]`;
  missing file, malformed JSON, missing `category`, both/neither of
  `term`/`pattern`, uncompilable `pattern` → each throws with a message
  identifying the specific problem; a `term` rule produces genuine
  word-boundary matching (verified via `classify()`, not just by
  inspecting the constructed regex).
- `main.test.ts`: coordinator refuses to start against a deliberately
  malformed rules file, mirroring the existing unset-`SWARM_AUTH_TOKEN`
  test. Every existing `main.test.ts` test that spawns the real process
  needs a valid `safety_rules.json` reachable from its spawn environment
  (same shape of fix Phase 1 needed for `SWARM_AUTH_TOKEN`).
- `safety_classifier.test.ts`, `server.test.ts`: unchanged — neither the
  classifier nor the HTTP layer's behavior changes.
- A live check that `POST /classify` against the real curated ruleset
  correctly flags at least one prompt per category and passes clearly
  benign prompts, belongs in this phase's whole-branch review, matching
  this project's established live-probing practice.
