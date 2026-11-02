/**
 * Durable material records for the platform integration (module 2).
 *
 * A material is the uploaded source file plus what OpenMAIC could read from it:
 * text, embedded images and a compact layout description. The record is stored
 * under `data/integration-materials/<id>/` (gitignored via `/data`) with the
 * original bytes beside `meta.json`, and expires after 24 hours.
 *
 * File-backed on purpose: the handoff flow only needs the material for a short
 * window, and this keeps the integration path independent of the workbench
 * material library's quota/identity machinery.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { nanoid } from 'nanoid';

export const INTEGRATION_MATERIAL_TTL_MS = 24 * 60 * 60 * 1000;
const MATERIALS_DIR = path.join(process.cwd(), 'data', 'integration-materials');
const MATERIAL_ID_PATTERN = /^mat_[A-Za-z0-9_-]{8,64}$/;

export interface IntegrationMaterialImage {
  id: string;
  /** Data URL (embedded image or a rendered page). */
  src: string;
  mimeType: string;
  order: number;
  /** 1-based source page, when known. */
  pageNumber?: number;
  width?: number;
  height?: number;
  /** `embedded` = image inside the document; `page` = rasterized layout reference. */
  kind: 'embedded' | 'page';
  description?: string;
}

export interface IntegrationMaterialLayout {
  pageCount?: number;
  /** Rasterized pages used as a layout reference for the generator. */
  pages?: Array<{ index: number; src: string; width?: number; height?: number }>;
  /** Reading-order blocks (currently: images, for DOCX). */
  blocks?: Array<{
    type: 'image' | 'paragraph';
    order: number;
    imageId?: string;
    width?: number;
    height?: number;
  }>;
  summary?: string;
}

export interface IntegrationMaterialRecord {
  id: string;
  tenantId?: string;
  fileName: string;
  mimeType: string;
  kind: string;
  size: number;
  createdAt: string;
  parser: string;
  text: string;
  images: IntegrationMaterialImage[];
  layout: IntegrationMaterialLayout;
}

export function isIntegrationMaterialId(value: string): boolean {
  return MATERIAL_ID_PATTERN.test(value);
}

function materialDir(id: string): string {
  if (!isIntegrationMaterialId(id)) {
    throw new Error(`Invalid integration material id: ${JSON.stringify(id)}`);
  }
  return path.join(MATERIALS_DIR, id);
}

function metaPath(id: string): string {
  return path.join(materialDir(id), 'meta.json');
}

async function ensureMaterialsDir(): Promise<void> {
  await fs.mkdir(MATERIALS_DIR, { recursive: true });
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, content, 'utf-8');
  await fs.rename(temp, filePath);
}

/**
 * Persist one material. The original bytes are written beside the metadata so
 * the source is available again if the caller wants to re-extract; they are
 * deleted with the record when it expires.
 */
export async function saveIntegrationMaterial(
  record: Omit<IntegrationMaterialRecord, 'id' | 'createdAt'>,
  original: { bytes: Buffer; fileName: string },
): Promise<IntegrationMaterialRecord> {
  await ensureMaterialsDir();
  await sweepExpiredMaterials();

  const id = `mat_${nanoid(16)}`;
  const dir = materialDir(id);
  await fs.mkdir(dir, { recursive: true });

  const extension = path
    .extname(original.fileName)
    .slice(0, 16)
    .replace(/[^A-Za-z0-9.]/g, '');
  await fs.writeFile(path.join(dir, `original${extension || '.bin'}`), original.bytes);

  const stored: IntegrationMaterialRecord = {
    ...record,
    id,
    createdAt: new Date().toISOString(),
  };
  await writeAtomic(metaPath(id), JSON.stringify(stored, null, 2));
  return stored;
}

export async function readIntegrationMaterial(
  id: string,
): Promise<IntegrationMaterialRecord | null> {
  if (!isIntegrationMaterialId(id)) return null;
  try {
    const raw = await fs.readFile(metaPath(id), 'utf-8');
    const record = JSON.parse(raw) as IntegrationMaterialRecord;
    const age = Date.now() - Date.parse(record.createdAt);
    if (!Number.isFinite(age) || age > INTEGRATION_MATERIAL_TTL_MS) {
      await deleteIntegrationMaterial(id);
      return null;
    }
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function deleteIntegrationMaterial(id: string): Promise<void> {
  if (!isIntegrationMaterialId(id)) return;
  await fs.rm(materialDir(id), { recursive: true, force: true }).catch(() => undefined);
}

/** Best-effort cleanup; a failed sweep must not fail an upload. */
export async function sweepExpiredMaterials(): Promise<void> {
  try {
    const entries = await fs.readdir(MATERIALS_DIR, { withFileTypes: true });
    const now = Date.now();
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && isIntegrationMaterialId(entry.name))
        .map(async (entry) => {
          const meta = path.join(MATERIALS_DIR, entry.name, 'meta.json');
          try {
            const stat = await fs.stat(meta);
            if (now - stat.mtimeMs > INTEGRATION_MATERIAL_TTL_MS) {
              await deleteIntegrationMaterial(entry.name);
            }
          } catch {
            // A half-written record is removed only when the directory is older
            // than the TTL as well.
            try {
              const dirStat = await fs.stat(path.join(MATERIALS_DIR, entry.name));
              if (now - dirStat.mtimeMs > INTEGRATION_MATERIAL_TTL_MS) {
                await deleteIntegrationMaterial(entry.name);
              }
            } catch {
              // ignore
            }
          }
        }),
    );
  } catch {
    // ignore: cleanup is opportunistic
  }
}
