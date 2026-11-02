/**
 * Short-lived handoff records for module 2.
 *
 * The platform creates a handoff after uploading materials; the browser is
 * redirected to `/game?handoff=<id>`, and the landing page reads the handoff
 * plus its materials. When the game is generated, the page reports the stage
 * back with the per-handoff completion token, and the platform polls the
 * integration status endpoint.
 *
 * File-backed under `data/integration-handoffs/` with a 2-hour TTL. The
 * completion token is the write capability for the browser-facing result
 * endpoint; the handoff id alone can only read the payload.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { nanoid } from 'nanoid';

export const INTEGRATION_HANDOFF_TTL_MS = 2 * 60 * 60 * 1000;
const HANDOFFS_DIR = path.join(process.cwd(), 'data', 'integration-handoffs');
const HANDOFF_ID_PATTERN = /^ho_[A-Za-z0-9_-]{8,64}$/;

export type IntegrationHandoffStatus = 'pending' | 'succeeded';

export interface IntegrationHandoff {
  id: string;
  tenantId: string;
  teacherId?: string;
  externalCourseId?: string;
  externalChapterId?: string;
  prompt: string;
  materialIds: string[];
  mode: 'single-game';
  returnUrl?: string;
  completionToken: string;
  status: IntegrationHandoffStatus;
  stageId?: string;
  resourceUrl?: string;
  createdAt: string;
  expiresAt: string;
}

export function isIntegrationHandoffId(value: string): boolean {
  return HANDOFF_ID_PATTERN.test(value);
}

function handoffPath(id: string): string {
  if (!isIntegrationHandoffId(id)) {
    throw new Error(`Invalid integration handoff id: ${JSON.stringify(id)}`);
  }
  return path.join(HANDOFFS_DIR, `${id}.json`);
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, content, 'utf-8');
  await fs.rename(temp, filePath);
}

export async function createIntegrationHandoff(input: {
  tenantId: string;
  teacherId?: string;
  externalCourseId?: string;
  externalChapterId?: string;
  prompt: string;
  materialIds: string[];
  returnUrl?: string;
}): Promise<IntegrationHandoff> {
  await fs.mkdir(HANDOFFS_DIR, { recursive: true });
  await sweepExpiredHandoffs();

  const now = Date.now();
  const handoff: IntegrationHandoff = {
    id: `ho_${nanoid(16)}`,
    tenantId: input.tenantId,
    ...(input.teacherId ? { teacherId: input.teacherId } : {}),
    ...(input.externalCourseId ? { externalCourseId: input.externalCourseId } : {}),
    ...(input.externalChapterId ? { externalChapterId: input.externalChapterId } : {}),
    prompt: input.prompt,
    materialIds: input.materialIds,
    mode: 'single-game',
    ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
    completionToken: nanoid(32),
    status: 'pending',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + INTEGRATION_HANDOFF_TTL_MS).toISOString(),
  };

  await writeAtomic(handoffPath(handoff.id), JSON.stringify(handoff, null, 2));
  return handoff;
}

export async function readIntegrationHandoff(id: string): Promise<IntegrationHandoff | null> {
  if (!isIntegrationHandoffId(id)) return null;
  try {
    const raw = await fs.readFile(handoffPath(id), 'utf-8');
    const handoff = JSON.parse(raw) as IntegrationHandoff;
    if (Date.parse(handoff.expiresAt) <= Date.now()) {
      await deleteIntegrationHandoff(id);
      return null;
    }
    return handoff;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function deleteIntegrationHandoff(id: string): Promise<void> {
  if (!isIntegrationHandoffId(id)) return;
  await fs.rm(handoffPath(id), { force: true }).catch(() => undefined);
}

/**
 * Record the generated course. The completion token is required; the handoff
 * id alone is only a read capability.
 */
export async function completeIntegrationHandoff(input: {
  id: string;
  completionToken: string;
  stageId: string;
  resourceUrl: string;
}): Promise<IntegrationHandoff | null> {
  const handoff = await readIntegrationHandoff(input.id);
  if (!handoff) return null;
  if (handoff.completionToken !== input.completionToken) return null;

  const updated: IntegrationHandoff = {
    ...handoff,
    status: 'succeeded',
    stageId: input.stageId,
    resourceUrl: input.resourceUrl,
  };
  await writeAtomic(handoffPath(updated.id), JSON.stringify(updated, null, 2));
  return updated;
}

/** Best-effort cleanup; a failed sweep must not fail a request. */
export async function sweepExpiredHandoffs(): Promise<void> {
  try {
    const entries = await fs.readdir(HANDOFFS_DIR, { withFileTypes: true });
    const now = Date.now();
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map(async (entry) => {
          const id = entry.name.slice(0, -'.json'.length);
          if (!isIntegrationHandoffId(id)) return;
          try {
            const raw = await fs.readFile(path.join(HANDOFFS_DIR, entry.name), 'utf-8');
            const handoff = JSON.parse(raw) as IntegrationHandoff;
            if (Date.parse(handoff.expiresAt) <= now) {
              await deleteIntegrationHandoff(id);
            }
          } catch {
            // A malformed file is left for a human; it cannot be addressed.
          }
        }),
    );
  } catch {
    // ignore: cleanup is opportunistic
  }
}
