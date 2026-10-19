/**
 * PATCH /api/materials/library/[id] — put one library material into, or take it
 * out of, the owner knowledge base.
 *
 * ## Why this is a toggle and not a second upload
 *
 * The knowledge base is a derived index over a material that already exists, so
 * the only thing to decide here is whether it is part of it. Enabling queues an
 * index build and answers immediately (the build runs after the response, see
 * lib/server/knowledge-base/index-task.ts); the state the client then polls is
 * the same `knowledge` field `GET /api/materials/library` already returns.
 * Disabling deletes the index — the material itself is untouched, and the
 * library keeps working exactly as before.
 *
 * Every failure mode is distinguished on purpose. A caller can tell apart: no
 * embedding route on this deployment (409, nothing they can do), a material
 * that is not theirs or not ready (404, the library's usual non-oracle), and a
 * malformed body (400).
 */
import type { NextRequest } from 'next/server';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { apiError } from '@/lib/server/api-response';
import { ownerJson, ownerNotFound } from '@/lib/server/agent-runtime/route-response';
import { hasConfiguredKnowledgeBaseEmbedding } from '@/lib/server/knowledge-base/embed';
import { scheduleKnowledgeIndex } from '@/lib/server/knowledge-base/index-task';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import {
  deleteKnowledgeDocument,
  getKnowledgeDocument,
} from '@/lib/persistence/knowledge-base';
import { getReadyOwnerMaterials } from '@/lib/persistence/owner-materials';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

import { knowledgeStatusView } from '../route';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

interface PatchBody {
  /** Whether this material should be part of the owner knowledge base. */
  knowledgeBase?: unknown;
}

export async function PATCH(req: NextRequest, { params }: Params) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  let body: PatchBody = {};
  try {
    body = ((await req.json()) ?? {}) as PatchBody;
  } catch {
    return apiError('INVALID_REQUEST', 400, 'invalid JSON body');
  }
  if (typeof body.knowledgeBase !== 'boolean') {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'knowledgeBase (boolean) is required');
  }
  const enabled = body.knowledgeBase;
  const { id: materialId } = await params;

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const provider = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const queryable = provider.pool as unknown as ConnectableQueryable;

    if (!enabled) {
      await deleteKnowledgeDocument(queryable, ownerId, materialId);
      return ownerJson(
        { materialId, knowledge: { available: hasConfiguredKnowledgeBaseEmbedding(), state: 'none' } },
        200,
        responseHeaders,
      );
    }

    // Refused before anything is queued: without an embedding route there is no
    // index this call could produce, and answering "accepted" would be a lie
    // the client could only discover by polling forever.
    if (!hasConfiguredKnowledgeBaseEmbedding()) {
      return apiError(
        'INVALID_REQUEST',
        409,
        'this deployment has no embedding model configured, so it cannot build a knowledge base',
      );
    }

    // The material must be the owner's and must be a finished upload. Same
    // non-oracle answer as everywhere else in the library: a foreign id and a
    // missing one are indistinguishable.
    const [material] = await getReadyOwnerMaterials(queryable, ownerId, [materialId]);
    if (!material) return ownerNotFound(responseHeaders);

    const current = await getKnowledgeDocument(queryable, ownerId, materialId);
    // Already usable: re-queueing would rebuild an identical index and take the
    // material out of service for the duration, for no gain.
    if (current?.state === 'ready' || current?.state === 'indexing') {
      return ownerJson(
        { materialId, knowledge: knowledgeStatusView(current, true) },
        200,
        responseHeaders,
      );
    }

    scheduleKnowledgeIndex(ownerId, materialId);
    return ownerJson(
      {
        materialId,
        knowledge: { available: true, state: 'indexing' },
      },
      202,
      responseHeaders,
    );
  });
}