export interface ClassificationResult {
  safe: boolean;
  categories: string[];
}

export interface SafetyClassifier {
  classify(prompt: string): Promise<ClassificationResult>;
}

export interface KeywordRule {
  pattern: RegExp;
  category: string;
}

// A deliberately naive, non-production reference classifier. It exists to
// prove the SafetyClassifier gate's plumbing (block/allow decisions,
// category reporting, fail-closed error handling in the HTTP layer) works
// correctly -- it is NOT a real content-moderation implementation, and
// ships with zero rules by default. Wiring in a real classifier (e.g. a
// model-backed one calling the C++ InferenceEngine) means implementing
// SafetyClassifier, not extending this class.
export class KeywordSafetyClassifier implements SafetyClassifier {
  private readonly rules: KeywordRule[];

  constructor(rules: KeywordRule[]) {
    // Rebuild every rule rather than storing the caller's array/patterns by
    // reference. Two independent problems this fixes:
    //
    // 1. RegExp.prototype.test mutates .lastIndex when the pattern carries
    //    the `g` or `y` flag, so a rule written the natural way (/token/g)
    //    would make the SAME prompt alternate between matching and not
    //    matching across successive classify() calls -- a real fail-open.
    //    Stripping g/y (order/behavior is otherwise unaffected for a single
    //    test() per call) makes matching stateless and deterministic.
    // 2. `.map()` produces a fresh array, so a caller who mutates their own
    //    rules array after construction (e.g. pushing a new rule) cannot
    //    silently alter the classifier's already-constructed policy.
    this.rules = rules.map(r => ({
      category: r.category,
      pattern: /[gy]/.test(r.pattern.flags)
        ? new RegExp(r.pattern.source, r.pattern.flags.replace(/[gy]/g, ""))
        : r.pattern,
    }));
  }

  async classify(prompt: string): Promise<ClassificationResult> {
    const categories: string[] = [];
    for (const rule of this.rules) {
      if (rule.pattern.test(prompt)) {
        categories.push(rule.category);
      }
    }
    return { safe: categories.length === 0, categories };
  }
}
