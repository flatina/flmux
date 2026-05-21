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
  }
}

// role mandatory gate; id/ancestorIdHint=3, name=2, textHash/domOrderKey=1
export function signatureScore(a: RefSignature, b: RefSignature): number {
  if (a.role !== b.role) return 0;
  let score = 2;
  const aId = a.id || a.ancestorIdHint;
  const bId = b.id || b.ancestorIdHint;
  if (aId && aId === bId) score += 3;
  if (a.name === b.name && a.name.length > 0) score += 2;
  if (a.textHash === b.textHash) score += 1;
  if (a.domOrderKey === b.domOrderKey) score += 1;
  return score;
}

export const SIGNATURE_MATCH_THRESHOLD = 4;
