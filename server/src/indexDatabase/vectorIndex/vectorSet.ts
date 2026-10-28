import { EMBEDDING_SCALE_HEADER_BYTES } from "../embeddingCodec.ts";
import { dotProducts } from "./dotProducts.ts";

export type ScoredFile = { folder: string; fileName: string; similarity: number };

const separator = "\u0000";
const keyOf = (folder: string, fileName: string) => `${folder}${separator}${fileName}`;
const splitKey = (key: string) => {
  const at = key.indexOf(separator);
  return { folder: key.slice(0, at), fileName: key.slice(at + 1) };
};

/**
 * Every stored embedding of one kind (CLIP image or CLAP audio), packed into a
 * single row-major int8 matrix so a search is one pass over contiguous memory
 * rather than one SQLite function call per row. Rows are addressed by slot; a
 * removed file's slot is tombstoned (norm 0) and reused by the next insert.
 *
 * Similarity is cosine over the int8 components, exactly what the SQL
 * `cosine_similarity_i8` computes: the stored per-vector scale cancels out of
 * cosine, so it is never read (see embeddingCodec.ts).
 */
export class VectorSet {
  private dimension = 0;
  private matrix = new Int8Array(0);
  private norms = new Float64Array(0);
  private slotKeys: Array<string | null> = [];
  private slotByKey = new Map<string, number>();
  private freeSlots: number[] = [];

  get size(): number {
    return this.slotByKey.size;
  }

  upsert(folder: string, fileName: string, encoded: Uint8Array): void {
    const vector = this.components(encoded);
    const key = keyOf(folder, fileName);
    let slot = this.slotByKey.get(key);
    if (slot === undefined) {
      slot = this.freeSlots.pop() ?? this.appendSlot();
      this.slotByKey.set(key, slot);
      this.slotKeys[slot] = key;
    }
    this.matrix.set(vector, slot * this.dimension);
    let squared = 0;
    for (let i = 0; i < vector.length; i++) squared += vector[i] * vector[i];
    this.norms[slot] = Math.sqrt(squared);
  }

  remove(folder: string, fileName: string): void {
    const key = keyOf(folder, fileName);
    const slot = this.slotByKey.get(key);
    if (slot === undefined) return;
    this.slotByKey.delete(key);
    this.slotKeys[slot] = null;
    this.norms[slot] = 0;
    this.freeSlots.push(slot);
  }

  /** Mirrors `DELETE … WHERE folder LIKE '<prefix>%'`. */
  removeFolder(folderPrefix: string): void {
    for (const key of [...this.slotByKey.keys()]) {
      const { folder, fileName } = splitKey(key);
      if (folder.startsWith(folderPrefix)) this.remove(folder, fileName);
    }
  }

  move(from: { folder: string; fileName: string }, to: { folder: string; fileName: string }): void {
    const fromKey = keyOf(from.folder, from.fileName);
    const slot = this.slotByKey.get(fromKey);
    if (slot === undefined) return;
    this.remove(to.folder, to.fileName);
    const toKey = keyOf(to.folder, to.fileName);
    this.slotByKey.delete(fromKey);
    this.slotByKey.set(toKey, slot);
    this.slotKeys[slot] = toKey;
  }

  /**
   * The `limit` most similar files, best first. With `allowed`, only those
   * files are ranked (for filters too selective for over-fetching to satisfy).
   */
  search(
    encodedQuery: Uint8Array,
    limit: number,
    allowedFiles?: ReadonlyArray<readonly [folder: string, fileName: string]>,
  ): ScoredFile[] {
    if (this.size === 0 || limit <= 0) return [];
    const allowed = allowedFiles && new Set(allowedFiles.map(([folder, fileName]) => keyOf(folder, fileName)));
    const query = this.components(encodedQuery);
    let querySquared = 0;
    for (let i = 0; i < query.length; i++) querySquared += query[i] * query[i];
    const queryNorm = Math.sqrt(querySquared);
    if (queryNorm === 0) return [];

    const rows = this.slotKeys.length;
    const dots = new Int32Array(rows);
    dotProducts(this.matrix, this.dimension, rows, query, dots);

    // Bounded min-heap of the best `limit` slots: O(rows · log limit), and no
    // allocation proportional to the library beyond `dots`. "Worst" means the
    // lowest score, and of equal scores the later slot, so ties are cut the
    // same way whatever `limit` is.
    const heapScores = new Float64Array(limit);
    const heapSlots = new Int32Array(limit);
    let heapSize = 0;
    const worse = (i: number, j: number) =>
      heapScores[i] < heapScores[j] || (heapScores[i] === heapScores[j] && heapSlots[i] > heapSlots[j]);
    const swap = (i: number, j: number) => {
      [heapScores[i], heapScores[j]] = [heapScores[j], heapScores[i]];
      [heapSlots[i], heapSlots[j]] = [heapSlots[j], heapSlots[i]];
    };

    for (let slot = 0; slot < rows; slot++) {
      const norm = this.norms[slot];
      if (norm === 0) continue;
      if (allowed && !allowed.has(this.slotKeys[slot] as string)) continue;
      const score = dots[slot] / (norm * queryNorm);
      if (heapSize < limit) {
        let i = heapSize++;
        heapScores[i] = score;
        heapSlots[i] = slot;
        for (let parent = (i - 1) >> 1; i > 0 && worse(i, parent); i = parent, parent = (i - 1) >> 1) {
          swap(i, parent);
        }
        continue;
      }
      // Slots arrive in ascending order, so an equal score is never better.
      if (score <= heapScores[0]) continue;
      heapScores[0] = score;
      heapSlots[0] = slot;
      for (let i = 0; ; ) {
        const left = 2 * i + 1;
        const right = left + 1;
        let worst = i;
        if (left < heapSize && worse(left, worst)) worst = left;
        if (right < heapSize && worse(right, worst)) worst = right;
        if (worst === i) break;
        swap(i, worst);
        i = worst;
      }
    }

    // Ties (the same photo in several folders scores identically) break by
    // slot, so the order is the same whatever `limit` is — paging relies on it.
    return Array.from({ length: heapSize }, (_, i) => i)
      .sort((a, b) => heapScores[b] - heapScores[a] || heapSlots[a] - heapSlots[b])
      .map((i) => ({ ...splitKey(this.slotKeys[heapSlots[i]] as string), similarity: heapScores[i] }));
  }

  private components(encoded: Uint8Array): Int8Array {
    const dimension = encoded.byteLength - EMBEDDING_SCALE_HEADER_BYTES;
    if (dimension <= 0) throw new Error(`Embedding blob too short (${encoded.byteLength} bytes)`);
    if (this.dimension === 0) this.dimension = dimension;
    if (dimension !== this.dimension) {
      throw new Error(`Embedding has ${dimension} dimensions; this index holds ${this.dimension}`);
    }
    return new Int8Array(encoded.buffer, encoded.byteOffset + EMBEDDING_SCALE_HEADER_BYTES, dimension);
  }

  private appendSlot(): number {
    const slot = this.slotKeys.length;
    this.slotKeys.push(null);
    const capacity = this.norms.length;
    if (slot >= capacity) {
      const grown = Math.max(1024, capacity * 2);
      const matrix = new Int8Array(grown * this.dimension);
      matrix.set(this.matrix);
      this.matrix = matrix;
      const norms = new Float64Array(grown);
      norms.set(this.norms);
      this.norms = norms;
    }
    return slot;
  }
}
