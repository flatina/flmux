export interface RefSignature {
  role: string;
  name: string;
  type?: string;
  id?: string;
  textHash: string;
  domOrderKey: string;
  ancestorIdHint?: string;
}

export interface RefEntry {
  ref: string;
  generation: number;
  snapshotEpoch: number;
  selector: string;
  frameId?: string;
  rect: { x: number; y: number; width: number; height: number };
  axPath?: string;
  signature: RefSignature;
}

export interface RefRegistrationInput extends Omit<RefEntry, "generation"> {}

export class RefRegistry {
  private generation = 0;
  private refs = new Map<string, RefEntry>();

  get currentGeneration(): number {
    return this.generation;
  }

  beginSnapshot(): number {
    this.generation += 1;
    this.refs.clear();
    return this.generation;
  }

  register(entries: RefRegistrationInput[]): void {
    for (const e of entries) this.refs.set(e.ref, { ...e, generation: this.generation });
  }

  get(ref: string): RefEntry | undefined {
    return this.refs.get(ref);
  }

  size(): number {
    return this.refs.size;
  }

  clear(): void {
    this.refs.clear();
    this.generation += 1;
  }
}

/** Weighted signature match score. Strong (id/ancestorIdHint) = 3, medium
 * (role/name) = 2, weak (textHash/domOrderKey) = 1. Threshold 5 = pass. */
export function signatureScore(a: RefSignature, b: RefSignature): number {
  let score = 0;
  if (a.id && a.id === b.id) score += 3;
  if (a.ancestorIdHint && a.ancestorIdHint === b.ancestorIdHint) score += 3;
  if (a.role === b.role) score += 2;
  if (a.name === b.name) score += 2;
  if (a.textHash === b.textHash) score += 1;
  if (a.domOrderKey === b.domOrderKey) score += 1;
  return score;
}

export const SIGNATURE_MATCH_THRESHOLD = 5;
