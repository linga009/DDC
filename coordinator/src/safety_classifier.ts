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
    this.rules = rules;
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
