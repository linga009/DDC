import { readFileSync } from "node:fs";
import type { KeywordRule } from "./safety_classifier.ts";

export class SafetyRulesError extends Error {}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  const rules: KeywordRule[] = [];

  rawRules.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
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
      rules.push({
        category: candidate.category,
        pattern: new RegExp(`\\b${escapeRegExp(term)}\\b`, "i"),
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
