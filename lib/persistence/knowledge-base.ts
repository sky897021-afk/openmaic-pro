/**
 * The owner knowledge base — the durable retrieval index behind
 * `search_knowledge_base`.
 *
 * ## Why this is not part of the material library
 *
 * `owner_material` (./owner-materials.ts) is the owner's *byte* library: what
 * was uploaded, in what format, how large. It deliberately never holds text —
 * the agent's session materials carry an extracted copy per session, and the
 * library row stays `extraction: idle` forever.
 *
 * A knowledge base cannot work that way. Its whole point is to be consulted
 * from a session that never attached the material, so it cannot live on the
 * session's copy, and it must not be re-derived on every conversation. So this
 * is a second, orthogonal layer: an owner-scoped index of chunked, embedded
 * text, built once per material and read by every session of that owner.
 *
 * ## Two tables, and why the state is not on the chunks
 *
 * `owner_knowledge_document` carries the per-material lifecycle
 * (`pending`/`indexing`/`ready`/`failed`) and the statistics; the chunk table
 * carries the vectors. They are separate because a document has state when it
 * has no chunks at all — that is exactly what `pending` and `failed` mean — and
 * a table keyed by chunk can express neither.
 *
 * `model` on the document row records which embedding model produced its
 * vectors. Vectors from two different models are not comparable, and scoring
 * one against the other does not fail, it just returns nonsense — so reads
 * filter on the model and a stale row is skipped rather than silently mixed in.
 *
 * `state` is only moved to `ready` in the same transaction that replaces the
 * chunks, so a search during a re-index sees the previous consistent pair
 * (old model, old chunks) rather than a new model against old vectors.
 */
import { splitSqlStatements, type Queryable } from '@openmaic/storage/document/pg';
import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';

export const KNOWLEDGE_DOCUMENT_STATES = ['pending', 'indexing', 'ready', 'failed'] as const;
export type KnowledgeDocumentState = (typeof KNOWLEDGE_DOCUMENT_STATES)[number];

export interface KnowledgeDocumentRecord {
  ownerId: string;
  materialId: string;
  state: KnowledgeDocumentState;
  /** The embedding model whose vectors this document's chunks hold. */
  model: string | null;
  chunkCount: number;
  /** Characters of extracted text that were indexed. */
  chars: number;
  error: string | null;
  requestedAt: number;
  updatedAt: number;
}

export interface KnowledgeChunkVector {
  materialId: string;
  ordinal: number;
  text: string;
  /** Little-endian float32; see lib/knowledge-base/vector.ts. */
  embedding: Uint8Array;
  /** The model of the document these vectors belong to. */
  model: string | null;
}

/** A chunk as produced by the indexer, before it reaches the database. */
export interface KnowledgeChunkInput {
  text: string;
  embedding: Uint8Array;
}

export const KNOWLEDGE_BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS owner_knowledge_document (
  owner_id TEXT NOT NULL,
  material_id TEXT NOT NULL,
  state TEXT NOT NULL,
  model TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  chars INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  requested_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (owner_id, material_id)
);

CREATE TABLE IF NOT EXISTS owner_knowledge_chunk (
  owner_id TEXT NOT NULL,
  material_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding BYTEA NOT NULL,
  PRIMARY KEY (owner_id, material_id, ordinal)
);
`;

export async function ensureKnowledgeBaseSchema(queryable: Queryable): Promise<void> {
  // splitSqlStatements skips `--` comments and quoted strings, so prose in the
  // DDL above can never be split into a statement of its own.
  for (const statement of splitSqlStatements(KNOWLEDGE_BASE_SCHEMA)) {
    await queryable.query(statement);
  }
}

interface RawDocumentRow extends Record<string, unknown> {
  owner_id: string;
  material_id: string;
  state: string;
  model: string | null;
  chunk_count: number | string;
  chars: number | string;
  error: string | null;
  requested_at: number | string;
  updated_at: number | string;
}

const DOCUMENT_COLUMNS = `owner_id,
  material_id,
  state,
  model,
  chunk_count,
  chars,
  error,
  requested_at,
  updated_at`;

function rowToDocument(row: RawDocumentRow): KnowledgeDocumentRecord {
  return {
    ownerId: row.owner_id,
    materialId: row.material_id,
    state: row.state as KnowledgeDocumentState,
    model: row.model,
    chunkCount: Number(row.chunk_count),
    chars: Number(row.chars),
    error: row.error,
    requestedAt: Number(row.requested_at),
    updatedAt: Number(row.updated_at),
  };
}

/** Every knowledge-base document this owner has, ready or not. */
export async function listKnowledgeDocuments(
  queryable: Queryable,
  ownerId: string,
): Promise<KnowledgeDocumentRecord[]> {
  const result = await queryable.query<RawDocumentRow>(
    `SELECT ${DOCUMENT_COLUMNS}
       FROM owner_knowledge_document
      WHERE owner_id = $1
      ORDER BY requested_at DESC, material_id`,
    [ownerId],
  );
  return result.rows.map(rowToDocument);
}

export async function getKnowledgeDocument(
  queryable: Queryable,
  ownerId: string,
  materialId: string,
): Promise<KnowledgeDocumentRecord | null> {
  const result = await queryable.query<RawDocumentRow>(
    `SELECT ${DOCUMENT_COLUMNS}
       FROM owner_knowledge_document
      WHERE owner_id = $1 AND material_id = $2`,
    [ownerId, materialId],
  );
  return result.rows[0] ? rowToDocument(result.rows[0]) : null;
}

/**
 * Claim a document for indexing.
 *
 * Deliberately leaves `model`, `chunk_count`, and `chars` untouched: the
 * previous index is still the consistent one until {@link storeKnowledgeIndex}
 * replaces it, and a search landing in the gap must see that older pair whole
 * rather than a new model name against old vectors.
 */
export async function markKnowledgeIndexing(
  queryable: Queryable,
  ownerId: string,
  materialId: string,
): Promise<void> {
  const now = Date.now();
  await queryable.query(
    `INSERT INTO owner_knowledge_document
       (owner_id, material_id, state, model, chunk_count, chars, error, requested_at, updated_at)
     VALUES ($1, $2, 'indexing', NULL, 0, 0, NULL, $3, $3)
     ON CONFLICT (owner_id, material_id) DO UPDATE
        SET state = 'indexing',
            error = NULL,
            requested_at = EXCLUDED.requested_at,
            updated_at = EXCLUDED.updated_at`,
    [ownerId, materialId, now],
  );
}

/** Rows per INSERT; keeps the parameter count far under the protocol ceiling. */
const CHUNK_INSERT_BATCH = 200;

/**
 * Replace a document's chunks and mark it ready — atomically.
 *
 * The delete and the inserts share one transaction with the state change, so
 * there is no instant at which the row says `ready` while its vectors are
 * partly old or partly missing. The state is the promise; this is what makes
 * the promise true at a single point in time.
 */
export async function storeKnowledgeIndex(
  queryable: ConnectableQueryable,
  ownerId: string,
  materialId: string,
  input: { model: string; chars: number; chunks: readonly KnowledgeChunkInput[] },
): Promise<KnowledgeDocumentRecord> {
  const withTransaction = nodePostgresTransaction(queryable);
  return withTransaction(async (tx) => {
    await tx.query(
      `DELETE FROM owner_knowledge_chunk
        WHERE owner_id = $1 AND material_id = $2`,
      [ownerId, materialId],
    );
    for (let start = 0; start < input.chunks.length; start += CHUNK_INSERT_BATCH) {
      const batch = input.chunks.slice(start, start + CHUNK_INSERT_BATCH);
      const placeholders = batch
        .map((_, index) => {
          const base = index * 5;
          return `($1, $2, $${base + 3}, $${base + 4}, $${base + 5})`;
        })
        .join(', ');
      const values: unknown[] = [ownerId, materialId];
      for (const [index, chunk] of batch.entries()) {
        values.push(start + index, chunk.text, Buffer.from(chunk.embedding));
      }
      await tx.query(
        `INSERT INTO owner_knowledge_chunk
           (owner_id, material_id, ordinal, text, embedding)
         VALUES ${placeholders}`,
        values,
      );
    }
    const now = Date.now();
    const saved = await tx.query<RawDocumentRow>(
      `INSERT INTO owner_knowledge_document
         (owner_id, material_id, state, model, chunk_count, chars, error, requested_at, updated_at)
       VALUES ($1, $2, 'ready', $3, $4, $5, NULL, $6, $6)
       ON CONFLICT (owner_id, material_id) DO UPDATE
          SET state = 'ready',
              model = EXCLUDED.model,
              chunk_count = EXCLUDED.chunk_count,
              chars = EXCLUDED.chars,
              error = NULL,
              updated_at = EXCLUDED.updated_at
       RETURNING ${DOCUMENT_COLUMNS}`,
      [ownerId, materialId, input.model, input.chunks.length, input.chars, now],
    );
    return rowToDocument(saved.rows[0]);
  });
}

/**
 * Record a failed index attempt.
 *
 * Existing chunks are left in place but stop being readable, because reads join
 * on `state = 'ready'`. Dropping them here would be worse: a later successful
 * retry would then have to rebuild from nothing even though the previous index
 * is still perfectly usable if the operator rolls the model back.
 */
export async function markKnowledgeIndexFailed(
  queryable: Queryable,
  ownerId: string,
  materialId: string,
  error: string,
): Promise<void> {
  // Truncated: the column reports to a UI tooltip, and a stack trace in a
  // status field is noise, not diagnosis.
  const reason = error.slice(0, 500);
  await queryable.query(
    `UPDATE owner_knowledge_document
        SET state = 'failed', error = $3, updated_at = $4
      WHERE owner_id = $1 AND material_id = $2`,
    [ownerId, materialId, reason, Date.now()],
  );
}

/** Drop a material from the knowledge base entirely — chunks first, then state. */
export async function deleteKnowledgeDocument(
  queryable: ConnectableQueryable,
  ownerId: string,
  materialId: string,
): Promise<void> {
  const withTransaction = nodePostgresTransaction(queryable);
  await withTransaction(async (tx) => {
    await tx.query(
      `DELETE FROM owner_knowledge_chunk WHERE owner_id = $1 AND material_id = $2`,
      [ownerId, materialId],
    );
    await tx.query(
      `DELETE FROM owner_knowledge_document WHERE owner_id = $1 AND material_id = $2`,
      [ownerId, materialId],
    );
  });
}

interface RawChunkRow extends Record<string, unknown> {
  material_id: string;
  ordinal: number | string;
  text: string;
  embedding: Uint8Array;
  model: string | null;
}

/**
 * Every readable vector this owner has.
 *
 * Restricted to `ready` documents, and the document's `model` rides along so
 * the caller can refuse to score vectors from a model other than the one it
 * embedded the query with. Unpaged by design — the whole index is a few
 * megabytes, and the exact scan is what replaces the missing vector index.
 */
export async function loadKnowledgeChunkVectors(
  queryable: Queryable,
  ownerId: string,
): Promise<KnowledgeChunkVector[]> {
  const result = await queryable.query<RawChunkRow>(
    `SELECT chunk.material_id,
            chunk.ordinal,
            chunk.text,
            chunk.embedding,
            document.model
       FROM owner_knowledge_chunk AS chunk
       JOIN owner_knowledge_document AS document
         ON document.owner_id = chunk.owner_id
        AND document.material_id = chunk.material_id
      WHERE chunk.owner_id = $1
        AND document.state = 'ready'
      ORDER BY chunk.material_id, chunk.ordinal`,
    [ownerId],
  );
  return result.rows.map((row) => ({
    materialId: row.material_id,
    ordinal: Number(row.ordinal),
    text: row.text,
    embedding: row.embedding,
    model: row.model,
  }));
}