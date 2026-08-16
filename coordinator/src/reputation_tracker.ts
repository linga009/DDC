interface NodeStats {
  agreements: number;
  disagreements: number;
}

const DEFAULT_MIN_SAMPLES = 5;
const DEFAULT_DISAGREEMENT_THRESHOLD = 0.5;

export class ReputationTracker {
  private readonly minSamples: number;
  private readonly disagreementThreshold: number;
  private readonly stats = new Map<string, NodeStats>();

  constructor(
    minSamples: number = DEFAULT_MIN_SAMPLES,
    disagreementThreshold: number = DEFAULT_DISAGREEMENT_THRESHOLD,
  ) {
    this.minSamples = minSamples;
    this.disagreementThreshold = disagreementThreshold;
  }

  private getOrCreate(nodeId: string): NodeStats {
    let entry = this.stats.get(nodeId);
    if (!entry) {
      entry = { agreements: 0, disagreements: 0 };
      this.stats.set(nodeId, entry);
    }
    return entry;
  }

  recordAgreement(nodeId: string): void {
    this.getOrCreate(nodeId).agreements += 1;
  }

  recordDisagreement(nodeId: string): void {
    this.getOrCreate(nodeId).disagreements += 1;
  }

  isTrusted(nodeId: string): boolean {
    const entry = this.stats.get(nodeId);
    if (!entry) {
      return true;
    }
    const total = entry.agreements + entry.disagreements;
    if (total < this.minSamples) {
      return true;
    }
    return entry.disagreements / total < this.disagreementThreshold;
  }

  getStats(nodeId: string): NodeStats {
    const entry = this.stats.get(nodeId);
    return entry ? { ...entry } : { agreements: 0, disagreements: 0 };
  }
}
