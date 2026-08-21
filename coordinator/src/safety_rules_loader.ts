import { readFileSync } from "node:fs";
import type { KeywordRule } from "./safety_classifier.ts";

export class SafetyRulesError extends Error {}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Widen every apostrophe in an ALREADY-ESCAPED term into a character class
// matching either quote style. iOS, macOS, Word and many chat UIs autocorrect
// a typed straight apostrophe (U+0027) into a right single quotation mark
// (U+2019), so a rule written as "clone someone's bank card" would otherwise
// miss a user who typed that exact phrase anywhere autocorrect is on -- that
// is a trivially-reachable bypass, not the disclosed rephrasing/misspelling
// limitation. Applied here (generically, to every current and future term)
// rather than by hand-writing variants into safety_rules.json.
//
// Order matters: this runs AFTER escapeRegExp. Neither apostrophe is a regex
// metacharacter, so escapeRegExp leaves both untouched and the "[" / "]" this
// introduces are not themselves re-escaped afterwards.
function widenApostrophes(escaped: string): string {
  return escaped.replace(/['’]/g, "['’]");
}

export function loadSafetyRules(filePath: string | URL): KeywordRule[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new SafetyRulesError(
      `failed to read safety rules file ${filePath}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SafetyRulesError(
      `safety rules file ${filePath} is not valid JSON: ${(err as Error).message}`,
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as Record<string, unknown>).rules)
  ) {
    throw new SafetyRulesError(
      `safety rules file ${filePath} must be a JSON object with a "rules" array`,
    );
  }

  const rawRules = (parsed as { rules: unknown[] }).rules;

  // An empty ruleset is the one failure mode that looks exactly like success:
  // the coordinator would start with a byte-identical startup log and then
  // report every prompt -- including the worst ones -- as safe:true, with
  // nothing anywhere to signal that the gate had been disarmed. Fail fast
  // instead, which is this loader's whole reason to exist.
  if (rawRules.length === 0) {
    throw new SafetyRulesError(
      `safety rules file ${filePath} has an empty "rules" array -- a rule-less classifier reports every prompt as safe`,
    );
  }

  const rules: KeywordRule[] = [];

  rawRules.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new SafetyRulesError(`safety rule at index ${index} must be an object`);
    }
    const candidate = entry as Record<string, unknown>;

    if (typeof candidate.category !== "string" || candidate.category.length === 0) {
      throw new SafetyRulesError(
        `safety rule at index ${index} must have a non-empty "category" string`,
      );
    }

    const hasTerm = typeof candidate.term === "string";
    const hasPattern = typeof candidate.pattern === "string";

    if (hasTerm && hasPattern) {
      throw new SafetyRulesError(
        `safety rule at index ${index} (category "${candidate.category}") must have exactly one of "term" or "pattern", not both`,
      );
    }
    if (!hasTerm && !hasPattern) {
      throw new SafetyRulesError(
        `safety rule at index ${index} (category "${candidate.category}") must have exactly one of "term" or "pattern"`,
      );
    }

    if (hasTerm) {
      const term = candidate.term as string;
      if (term.length === 0) {
        throw new SafetyRulesError(
          `safety rule at index ${index} (category "${candidate.category}") has an empty "term"`,
        );
      }
      // \b requires a word/non-word transition on both sides of the match,
      // not just "start/end of the term". A term that starts or ends with
      // punctuation (e.g. "!" or ")") can silently fail to match if that
      // punctuation is itself adjacent to another non-word character (like
      // a space) in the text being classified -- non-word followed by
      // non-word is not a boundary. This is a real limitation of the
      // word-boundary approach, not a bug in the escaping above: rule
      // authors should avoid leading/trailing punctuation in "term"
      // entries; use the "pattern" escape hatch (raw regex source, no
      // \b-wrapping) for a rule that genuinely needs one.
      rules.push({
        category: candidate.category,
        pattern: new RegExp(`\\b${widenApostrophes(escapeRegExp(term))}\\b`, "i"),
      });
    } else {
      // "pattern" is raw regex source, authored by hand -- unlike "term"
      // (which is escaped literal text), a hand-written pattern CAN express
      // catastrophic backtracking (e.g. nested quantifiers like (a+)+b).
      // There's no complexity linting here; a rule author adding a
      // "pattern" entry is responsible for keeping it simple and avoiding
      // nested/overlapping quantifiers.
      const source = candidate.pattern as string;
      let compiled: RegExp;
      try {
        compiled = new RegExp(source, "i");
      } catch (err) {
        throw new SafetyRulesError(
          `safety rule at index ${index} (category "${candidate.category}") has an invalid regex pattern "${source}": ${(err as Error).message}`,
        );
      }
      rules.push({ category: candidate.category, pattern: compiled });
    }
  });

  return rules;
}
