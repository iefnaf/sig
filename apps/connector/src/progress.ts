// Progress throttling, docs/design/connector-pi.md §11.2:
// - emit immediately when the tool type changes;
// - while the same type continues, at most one per 15 seconds;
// - never more than one per 5 seconds in any case (the absolute cap wins over "immediately").
// `target` truncation to 80 chars happens upstream (normalization), never here.

export interface ProgressThrottleOptions {
  /** Absolute minimum spacing between any two emitted progress events. */
  minIntervalMs?: number;
  /** Spacing while the same phase+tool continues. */
  sameKindIntervalMs?: number;
}

interface Emitted {
  kind: string;
  at: number;
}

export class ProgressThrottle {
  private readonly minIntervalMs: number;
  private readonly sameKindIntervalMs: number;
  private last?: Emitted;

  constructor(options: ProgressThrottleOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 5000;
    this.sameKindIntervalMs = options.sameKindIntervalMs ?? 15000;
  }

  /** Returns true when a progress event with this phase/tool should be emitted at `now`. */
  decide(now: number, phase: string, tool?: string): boolean {
    const kind = tool ? `${phase}:${tool}` : phase;
    if (this.last) {
      const sinceLast = now - this.last.at;
      if (sinceLast < this.minIntervalMs) return false; // absolute cap
      if (this.last.kind === kind && sinceLast < this.sameKindIntervalMs) return false; // same type continues
    }
    this.last = { kind, at: now };
    return true;
  }
}
