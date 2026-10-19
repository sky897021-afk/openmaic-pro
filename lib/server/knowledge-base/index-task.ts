/**
 * Background knowledge-base indexing.
 *
 * Indexing one manual means reading its bytes, extracting text, embedding a few
 * hundred chunks, and writing them — tens of seconds for a large document. That
 * is far too long to hold an HTTP response open for, and there is no worker
 * queue in this deployment to hand it to. `after()` is the primitive this
 * codebase already uses for exactly this shape of work
 * (./conversation-title-task.ts): it runs after the response is flushed, so the
 * toggle answers immediately while the index is built behind it.
 *
 * The task is deliberately not retried here. A failure is recorded on the
 * document row with its reason and surfaces in the picker, where the operator
 * can trigger it again — which is more useful than a silent automatic retry
 * loop against an endpoint that is misconfigured in a way retrying cannot fix.
 */
import { after } from 'next/server';

import { createLogger } from '@/lib/logger';

import { indexOwnerMaterialForKnowledgeBase } from './index-material';

const log = createLogger('KnowledgeBaseIndexTask');

async function runKnowledgeIndexTask(ownerId: string, materialId: string): Promise<void> {
  try {
    const document = await indexOwnerMaterialForKnowledgeBase({ ownerId, materialId });
    log.info(
      `material ${materialId}: indexed ${document.chunkCount} chunks (${document.chars} chars)`,
    );
  } catch (error) {
    // indexOwnerMaterialForKnowledgeBase has already written the `failed` state
    // and its reason onto the document row; this line is for the operator's log.
    log.error(`material ${materialId}: knowledge-base indexing failed`, error);
  }
}

/**
 * Queue one material for indexing after the current response.
 *
 * Throws only if the scheduling itself fails — `after()` refuses outside a
 * request scope — so a caller can answer "accepted" honestly rather than
 * claiming work that was never queued.
 */
export function scheduleKnowledgeIndex(ownerId: string, materialId: string): void {
  after(() => runKnowledgeIndexTask(ownerId, materialId));
}