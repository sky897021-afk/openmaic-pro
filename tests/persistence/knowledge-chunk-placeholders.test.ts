/**
 * The `VALUES` list for a batched chunk insert.
 *
 * This was `index * 5` — a stride that disagreed with the three values pushed
 * per row, so any batch past the first row named placeholders the bind list did
 * not have and Postgres rejected the entire insert. No database is needed to
 * pin the arithmetic: the string and the parameter order are the whole
 * contract, and they can only be checked together.
 */
import { describe, expect, it } from 'vitest';

import { chunkInsertPlaceholders } from '@/lib/persistence/knowledge-base';

/** Every `$N` in the list, in the order it appears. */
function bindings(placeholders: string): number[] {
  return [...placeholders.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
}

describe('chunkInsertPlaceholders', () => {
  it('gives each row the two shared bindings and three of its own', () => {
    expect(chunkInsertPlaceholders(1)).toBe('($1, $2, $3, $4, $5)');
    expect(chunkInsertPlaceholders(2)).toBe('($1, $2, $3, $4, $5), ($1, $2, $6, $7, $8)');
  });

  it('numbers placeholders contiguously, with no gap and no repeat across rows', () => {
    const count = 200;
    const numbers = bindings(chunkInsertPlaceholders(count));

    // Five bindings per row, but only the first two are reused...
    expect(numbers).toHaveLength(count * 5);
    // ...so the distinct set is the shared pair plus three per row.
    const highest = 2 + count * 3;
    expect([...new Set(numbers)].sort((a, b) => a - b)).toEqual(
      Array.from({ length: highest }, (_, index) => index + 1),
    );
    // ...and the statement never names a parameter the caller cannot bind.
    expect(Math.max(...numbers)).toBe(highest);
  });

  it('repeats the shared bindings once per row, in the order the values are pushed', () => {
    // Row N is `(owner, material, ordinal, text, embedding)` — the shared pair
    // first, then that row's three — which is exactly how `storeKnowledgeIndex`
    // pushes `[ownerId, materialId, ordinal, text, embedding]` per row.
    expect(bindings(chunkInsertPlaceholders(3))).toEqual([
      1, 2, 3, 4, 5, 1, 2, 6, 7, 8, 1, 2, 9, 10, 11,
    ]);
  });

  it('produces an empty list for an empty batch', () => {
    expect(chunkInsertPlaceholders(0)).toBe('');
  });
});
