/**
 * GET /api/materials/library — the read face of the owner material library.
 *
 * The upload face (`POST /api/materials`) only ever wrote. This is the missing
 * half: the owner's OWN ready source materials, so a composer can offer the
 * files already uploaded instead of asking for them again.
 *
 * Ownership is not a filter applied here — it is the query. `listOwnerMaterials`
 * takes its `ownerId` from the server-side identity resolution, so a client
 * cannot ask for another owner's library by construction, and the projection is
 * `publicMaterial`, which carries no `ossKey`, no digest, no status, and no
 * owner id.
 *
 * ## Why the knowledge-base state rides along
 *
 * The picker has to answer "is this usable as a knowledge base?" per row, and
 * that answer is not derivable from the material itself: a library row is
 * `extraction: idle` forever, indexed or not (indexing happens owner-side, see
 * lib/persistence/knowledge-base.ts). Fetching it separately would mean the
 * picker renders twice — once without the state, once with it — so the state is
 * joined into this response, in one query, under the same owner scope.
 */
import type { NextRequest } from 'next/server';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { hasConfiguredKnowledgeBaseEmbedding } from '@/lib/server/knowledge-base/embed';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import {
  listKnowledgeDocuments,
  type KnowledgeDocumentRecord,
} from '@/lib/persistence/knowledge-base';
import { listOwnerMaterials, publicMaterial } from '@/lib/persistence/owner-materials';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

export const runtime = 'nodejs';

export type KnowledgeState = 'none' | 'pending' | 'indexing' | 'ready' | 'failed';

/**
 * The model-visible shape of one material's knowledge-base status.
 *
 * `available: false` means this deployment cannot index at all (no embedding
 * route): the UI must not offer a control that could only fail, and it must not
 * read "not indexed" as "you chose not to".
 */
export function knowledgeStatusView(
  document: KnowledgeDocumentRecord | undefined,
  available: boolean,
): { available: boolean; state: KnowledgeState; chunkCount?: number; chars?: number; error?: string } {
  if (!document) return { available, state: 'none' };
  return {
    available,
    state: document.state,
    chunkCount: document.chunkCount,
    ...(document.chars ? { chars: document.chars } : {}),
    ...(document.error ? { error: document.error } : {}),
  };
}

export async function GET(req: NextRequest) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const provider = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const queryable = provider.pool as unknown as ConnectableQueryable;
    const available = hasConfiguredKnowledgeBaseEmbedding();
    const [records, knowledge] = await Promise.all([
      listOwnerMaterials(queryable, ownerId),
      available ? listKnowledgeDocuments(queryable, ownerId).catch(() => []) : Promise.resolve([]),
    ]);
    const byMaterial = new Map(knowledge.map((document) => [document.materialId, document]));
    return ownerJson(
      {
        knowledgeAvailable: available,
        materials: records
          .filter((record) => record.kind === 'source')
          .map((record) => ({
            ...publicMaterial(record),
            knowledge: knowledgeStatusView(byMaterial.get(record.id), available),
          })),
      },
      200,
      responseHeaders,
    );
  });
}