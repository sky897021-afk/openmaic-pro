/**
 * The vector arithmetic behind the knowledge base.
 *
 * ## Why the stored form is what it is
 *
 * This deployment's PostgreSQL has no `pgvector`, so there is no vector type,
 * no distance operator, and no approximate index. Retrieval is therefore an
 * exact scan performed in the application: read the candidate vectors, score
 * them, keep the best. The whole storage format is chosen to make that scan
 * cheap and the ranking exact:
 *
 *  - **Vectors are stored L2-normalized.** For unit vectors, cosine similarity
 *    and the dot product are the same number. Normalizing once at write time
 *    removes a division from every score in every later query, and removes the
 *    possibility of the two rankings disagreeing.
 *  - **Vectors are stored as raw little-endian float32.** 1024 dimensions cost
 *    4096 bytes. The same numbers as a JSON array of decimals cost several
 *    times that, and have to be parsed before they can be used; as bytes they
 *    are read straight into a typed array.
 *  - **The query is downcast to float32 before scoring.** Stored vectors have
 *    already lost the precision a float64 would keep. Scoring them against a
 *    float64 query would compare two different number systems and produce
 *    ordering that a re-run cannot reproduce — so both sides are put in the
 *    same one first.
 *
 * Endianness is written explicitly through `DataView` rather than relying on
 * the host's byte order: a file written on one machine must read back as the
 * same vector everywhere, and the "everything is little-endian now" assumption
 * is exactly the kind that survives until it does not.
 */

/** Normalize to unit length, in float32, ready to store or to score with. */
export function normalizeVector(values: readonly number[]): Float32Array {
  const vector = new Float32Array(values.length);
  let sumOfSquares = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = Number.isFinite(values[index]) ? values[index]! : 0;
    vector[index] = value;
    sumOfSquares += value * value;
  }
  const magnitude = Math.sqrt(sumOfSquares);
  if (magnitude === 0) return vector;
  for (let index = 0; index < vector.length; index += 1) vector[index]! /= magnitude;
  return vector;
}

/** Serialize one normalized vector to little-endian float32 bytes. */
export function encodeVector(vector: Float32Array): Uint8Array {
  const bytes = new Uint8Array(vector.length * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < vector.length; index += 1) {
    view.setFloat32(index * 4, vector[index]!, true);
  }
  return bytes;
}

/**
 * Read a stored vector back.
 *
 * A byte length that is not a multiple of four means the row was not written by
 * {@link encodeVector}; the trailing partial float is dropped rather than
 * decoded from a misaligned window, which would otherwise read four bytes that
 * belong to the next value.
 */
export function decodeVector(bytes: Uint8Array): Float32Array {
  const count = Math.floor(bytes.byteLength / 4);
  const vector = new Float32Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < count; index += 1) {
    vector[index] = view.getFloat32(index * 4, true);
  }
  return vector;
}

/** Dot product of two normalized vectors — i.e. their cosine similarity. */
export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length);
  let score = 0;
  for (let index = 0; index < length; index += 1) score += left[index]! * right[index]!;
  return score;
}

export interface ScoredVector<T> {
  item: T;
  score: number;
}

/**
 * Rank candidates by cosine similarity, best first.
 *
 * `minScore` is a floor, not a nicety: an embedding of unrelated text still has
 * a positive cosine against anything, so an unfiltered top-k always returns k
 * results however irrelevant they are — and those results are injected into the
 * model's context as if they were evidence. A floor lets retrieval say "nothing
 * here" instead of always producing something.
 *
 * Ties break on the input order, which the store defines as
 * `(material_id, ordinal)`, so the same query over the same index returns the
 * same list.
 */
export function rankBySimilarity<T>(
  candidates: ReadonlyArray<{ item: T; vector: Float32Array }>,
  query: Float32Array,
  options: { limit: number; minScore?: number } = { limit: 8 },
): ScoredVector<T>[] {
  const minScore = options.minScore ?? 0;
  const scored: Array<ScoredVector<T> & { order: number }> = [];
  for (const [order, candidate] of candidates.entries()) {
    const score = cosineSimilarity(query, candidate.vector);
    if (score < minScore) continue;
    scored.push({ item: candidate.item, score, order });
  }
  scored.sort((left, right) => right.score - left.score || left.order - right.order);
  return scored.slice(0, Math.max(0, options.limit)).map(({ item, score }) => ({ item, score }));
}