export interface CatalogEntry {
  id: string;
  displayName: string;
  minActiveNodes: number;
  // Total pipeline size (driver plus compute contributors together, not
  // contributors alone) this model needs to run at all -- absent or 1
  // means today's existing single-node path, untouched by Phase B. Only
  // >1 models ever engage pipeline_selector.ts/PipelineTracker/the
  // launcher.
  requiredNodeCount?: number;
}

export interface AvailabilityEntry extends CatalogEntry {
  available: boolean;
}

// Dev-scale thresholds for local testing only -- NOT the spec's real-world
// tens/hundreds/thousands. Recalibrate against measured per-node throughput
// before these numbers mean anything in production (see Plan 1's Known Risks
// and this plan's Global Constraints for why).
const DEFAULT_CATALOG: CatalogEntry[] = [
  { id: "tinyllama-1.1b", displayName: "TinyLlama 1.1B", minActiveNodes: 0 },
  { id: "qwen2.5-0.5b", displayName: "Qwen2.5 0.5B Instruct", minActiveNodes: 0 },
  { id: "deepseek-r1-distill-qwen-1.5b", displayName: "DeepSeek-R1-Distill-Qwen 1.5B", minActiveNodes: 0 },
  { id: "small-7b", displayName: "Small 7-8B dense model", minActiveNodes: 2 },
  { id: "mixtral-8x7b", displayName: "Mixtral 8x7B", minActiveNodes: 5 },
  { id: "mixtral-8x22b", displayName: "Mixtral 8x22B", minActiveNodes: 10 },
];

export class ModelCatalog {
  private readonly entries: CatalogEntry[];

  constructor(entries: CatalogEntry[] = DEFAULT_CATALOG) {
    this.entries = entries;
  }

  availability(activeNodeCount: number): AvailabilityEntry[] {
    return this.entries.map(entry => ({
      ...entry,
      available: activeNodeCount >= entry.minActiveNodes,
    }));
  }

  hasModel(id: string): boolean {
    return this.entries.some(entry => entry.id === id);
  }

  requiredNodeCount(id: string): number {
    return this.entries.find(entry => entry.id === id)?.requiredNodeCount ?? 1;
  }
}
