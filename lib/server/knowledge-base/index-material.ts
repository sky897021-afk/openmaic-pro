/**
 * Build (or rebuild) one library material's knowledge-base index.
 *
 * ## Why this does not go through session extraction
 *
 * Session extraction (`lib/server/material-extraction/runner.ts`) is driven by
 * a lease on a queued session material: it consumes a claim, writes a derived
 * row, and reports completion. The knowledge base has none of that — it is
 * owner-scoped, has no session, and must never write session rows. What it does
 * share is the *reading*: the same extractor registry, so a file is turned into
 * text identically whether the agent reads it or the index embeds it.
 *
 * ## The order is the crash story
 *
 * State is moved to `indexing` first, so a process death mid-build leaves a row
 * that says so rather than one that says `ready` over a half-built index (or
 * nothing at all, which would look like "never requested"). The chunks and the
 * `ready` state are written together in one transaction by
 * `storeKnowledgeIndex`, so there is no window in which the row promises an
 * index that is not there. Any failure lands in the `failed` state carrying its
 * reason, which is what the operator surface shows.
 */
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { getDocumentExtractorProviders, type DocumentExtractorProvider } from '@/lib/document';
import { indexableChunks } from '@/lib/knowledge-base/chunk';
import { normalizeVector, encodeVector } from '@/lib/knowledge-base/vector';
import {
  getKnowledgeDocument,
  listKnowledgeDocuments,
  markKnowledgeIndexFailed,
  markKnowledgeIndexing,
  storeKnowledgeIndex,
  type KnowledgeDocumentRecord,
} from '@/lib/persistence/knowledge-base';
import { getReadyOwnerMaterials } from '@/lib/persistence/owner-materials';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { artifactText } from '@/lib/server/material-extraction/extract';
import { getMaterialByteStore } from '@/lib/server/materials/bytes';
import { resolvePDFApiKey, resolvePDFBaseUrl } from '@/lib/server/provider-config';

import { embedTexts, resolveEmbeddingConnection, KnowledgeBaseEmbeddingError } from './embed';

export interface KnowledgeIndexDependencies {
  queryable?: ConnectableQueryable;
  /** Test seam; defaults to the owner material library read. */
  readMaterials?: typeof getReadyOwnerMaterials;
  /** Test seam; defaults to the local material byte store. */
  readBytes?: (ossKey: string) => Promise<Buffer>;
  /** Test seam; defaults to the document extractor registry. */
  extractText?: (input: { bytes: Buffer; mime: string; fileName?: string }) => Promise<string>;
  /** Test seam; defaults to the configured embedding endpoint. */
  embed?: (texts: readonly string[]) => Promise<number[][]>;
}

/**
 * Turn one source file into text with the document extractor registry.
 *
 * Candidate order and per-provider config mirror the session extractor exactly
 * (`artifactText` is the same function it uses); the difference is the absence
 * of a session, not a different reading of the file.
 */
async function defaultExtractText(input: {
  bytes: Buffer;
  mime: string;
  fileName?: string;
}): Promise<string> {
  const providers = getDocumentExtractorProviders();
  const candidates = providers.filter((provider: DocumentExtractorProvider) =>
    provider.supportedMimeTypes.includes(input.mime.toLowerCase()),
  );
  if (candidates.length === 0) {
    throw new Error(`no document extractor supports ${input.mime}`);
  }
  const errors: string[] = [];
  for (const provider of candidates) {
    try {
      const artifact = await provider.extract({
        buffer: input.bytes,
        fileName: input.fileName,
        fileSize: input.bytes.byteLength,
        mimeType: input.mime,
        config: {
          providerId: provider.id,
          apiKey: resolvePDFApiKey(provider.id) || undefined,
          baseUrl: resolvePDFBaseUrl(provider.id),
          allowEnvFallback: true,
          managed: true,
        },
      });
      const text = artifactText(artifact);
      if (text.trim()) return text;
      errors.push(`${provider.id}: produced no text`);
    } catch (error) {
      errors.push(`${provider.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`document extraction produced no text (${errors.join('; ')})`);
}

async function resolveQueryable(deps: KnowledgeIndexDependencies): Promise<ConnectableQueryable> {
  if (deps.queryable) return deps.queryable;
  const provider = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  return provider.pool as unknown as ConnectableQueryable;
}

/**
 * Index one material, or throw with the reason it could not be indexed.
 *
 * Refuses to start unless the embedding route is configured: without it the
 * chunk vectors could not be produced, and failing before the state moves keeps
 * the row out of `indexing` for a build that was never going to happen.
 */
export async function indexOwnerMaterialForKnowledgeBase(
  input: { ownerId: string; materialId: string; signal?: AbortSignal },
  deps: KnowledgeIndexDependencies = {},
): Promise<KnowledgeDocumentRecord> {
  const connection = resolveEmbeddingConnection();
  if (!connection) {
    throw new KnowledgeBaseEmbeddingError(
      'KNOWLEDGE_BASE_EMBEDDING_MODEL is not configured for this deployment',
    );
  }
  const queryable = await resolveQueryable(deps);
  const readMaterials = deps.readMaterials ?? getReadyOwnerMaterials;
  const readBytes = deps.readBytes ?? ((ossKey: string) => getMaterialByteStore().get(ossKey));
  const extractText = deps.extractText ?? defaultExtractText;
  const embed = deps.embed ?? ((texts: readonly string[]) => embedTexts(texts, { signal: input.signal }));

  await markKnowledgeIndexing(queryable, input.ownerId, input.materialId);

  try {
    const materials = await readMaterials(queryable, input.ownerId, [input.materialId]);
    const material = materials[0];
    if (!material) throw new Error(`material ${input.materialId} is not in this owner's library`);
    if (!material.mime) throw new Error(`material ${input.materialId} has no recorded mime type`);

    const bytes = await readBytes(material.ossKey);
    const text = await extractText({
      bytes,
      mime: material.mime,
      ...(material.originalName ? { fileName: material.originalName } : {}),
    });
    const chunks = indexableChunks(text);
    if (chunks.length === 0) {
      throw new Error('extracted text produced no indexable chunks');
    }

    const vectors = await embed(chunks.map((chunk) => chunk.text));
    if (vectors.length !== chunks.length) {
      throw new Error(
        `embedding endpoint returned ${vectors.length} vectors for ${chunks.length} chunks`,
      );
    }

    return await storeKnowledgeIndex(queryable, input.ownerId, input.materialId, {
      model: connection.route,
      chars: text.length,
      chunks: chunks.map((chunk, index) => ({
        text: chunk.text,
        // Normalized here, once, so every later query is a bare dot product and
        // the stored vectors are all in the same unit sphere regardless of the
        // magnitudes the endpoint happened to return.
        embedding: encodeVector(normalizeVector(vectors[index]!)),
      })),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Recording the failure must not mask it: a database that cannot record the
    // reason is itself the failure, and the caller sees the original either way.
    await markKnowledgeIndexFailed(queryable, input.ownerId, input.materialId, reason).catch(
      () => undefined,
    );
    throw error;
  }
}

/** The stored index for one material, or `null` when it was never indexed. */
export async function readKnowledgeDocument(
  ownerId: string,
  materialId: string,
  deps: KnowledgeIndexDependencies = {},
): Promise<KnowledgeDocumentRecord | null> {
  return getKnowledgeDocument(await resolveQueryable(deps), ownerId, materialId);
}

/**
 * Display names of the owner's READY knowledge-base documents, for the prompt.
 *
 * Only `ready`: a document still indexing, or one whose build failed, has no
 * searchable vectors, and naming it in the prompt would tell the model about a
 * source it cannot actually retrieve from.
 */
export async function listIndexedKnowledgeMaterialNames(
  ownerId: string,
  deps: KnowledgeIndexDependencies = {},
): Promise<string[]> {
  const queryable = await resolveQueryable(deps);
  const ready = (await listKnowledgeDocuments(queryable, ownerId)).filter(
    (document) => document.state === 'ready',
  );
  if (ready.length === 0) return [];
  const readMaterials = deps.readMaterials ?? getReadyOwnerMaterials;
  const records = await readMaterials(
    queryable,
    ownerId,
    ready.map((document) => document.materialId),
  );
  const names = new Map(records.map((record) => [record.id, record.originalName ?? record.id]));
  return ready.map((document) => names.get(document.materialId) ?? document.materialId);
}