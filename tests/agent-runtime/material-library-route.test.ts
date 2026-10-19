import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { OwnerMaterialRecord } from '@/lib/persistence/owner-materials';

const mocks = vi.hoisted(() => ({
  runtimeConfigured: true,
  resolveRequestOwnerId: vi.fn(),
  listOwnerMaterials: vi.fn(),
  queryPool: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeConfigured: () => mocks.runtimeConfigured,
}));
vi.mock('@/lib/server/identity/resolve', async () =>
  (await import('../helpers/owner-resolution-mock')).ownerResolveModule(
    mocks.resolveRequestOwnerId,
  ),
);
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({
    pool: mocks.queryPool,
  }),
}));
// Only the query is stubbed: `publicMaterial` stays the real projection, so the
// assertions below test the shape the route actually ships, not a stand-in.
vi.mock('@/lib/persistence/owner-materials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/persistence/owner-materials')>();
  return { ...actual, listOwnerMaterials: mocks.listOwnerMaterials };
});

import { GET } from '@/app/api/materials/library/route';

function ownerMaterial(overrides: Partial<OwnerMaterialRecord> = {}): OwnerMaterialRecord {
  return {
    id: 'mat_00000000000000000000000000',
    ownerId: 'owner-1',
    kind: 'source',
    derivedFrom: null,
    mime: 'text/markdown',
    bytes: 5,
    originalName: '讲义.md',
    ossKey: 'materials/owner-1/mat_00000000000000000000000000',
    sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    status: 'ready',
    extraction: { status: 'idle' },
    createdAt: 1_700_000_000_000,
    deletedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runtimeConfigured = true;
  mocks.resolveRequestOwnerId.mockReturnValue('owner-1');
  mocks.listOwnerMaterials.mockResolvedValue([ownerMaterial()]);
});

describe('GET /api/materials/library', () => {
  it("lists the owner's whole library through the owner projection", async () => {
    const response = await GET(new NextRequest('http://localhost/api/materials/library'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      materials: [
        {
          materialId: 'mat_00000000000000000000000000',
          kind: 'source',
          mime: 'text/markdown',
          bytes: 5,
          originalName: '讲义.md',
          extraction: { status: 'idle' },
          createdAt: '2023-11-14T22:13:20.000Z',
        },
      ],
    });
  });

  it('queries the resolved owner, unpaged', async () => {
    await GET(new NextRequest('http://localhost/api/materials/library'));

    expect(mocks.listOwnerMaterials).toHaveBeenCalledWith(mocks.queryPool, 'owner-1');
    expect(mocks.listOwnerMaterials).toHaveBeenCalledTimes(1);
  });

  it('never leaks the private columns', async () => {
    const response = await GET(new NextRequest('http://localhost/api/materials/library'));
    const body = (await response.json()) as { materials: Record<string, unknown>[] };

    for (const key of ['ossKey', 'sha256', 'status', 'ownerId', 'deletedAt', 'id']) {
      expect(body.materials[0]).not.toHaveProperty(key);
    }
    expect(JSON.stringify(body)).not.toContain('materials/owner-1/');
  });

  it("drops derived 'web' rows — the library is what the user uploaded", async () => {
    mocks.listOwnerMaterials.mockResolvedValue([
      ownerMaterial({ id: 'mat_source', kind: 'source' }),
      ownerMaterial({ id: 'mat_web', kind: 'web', derivedFrom: 'mat_source' }),
    ]);

    const response = await GET(new NextRequest('http://localhost/api/materials/library'));
    const body = (await response.json()) as { materials: { materialId: string }[] };

    expect(body.materials.map((m) => m.materialId)).toEqual(['mat_source']);
  });

  it('answers an empty list for an owner with no materials', async () => {
    mocks.listOwnerMaterials.mockResolvedValue([]);

    const response = await GET(new NextRequest('http://localhost/api/materials/library'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ materials: [] });
  });

  it('answers 404 when the agent runtime is not configured', async () => {
    mocks.runtimeConfigured = false;

    const response = await GET(new NextRequest('http://localhost/api/materials/library'));

    expect(response.status).toBe(404);
    expect(mocks.listOwnerMaterials).not.toHaveBeenCalled();
  });
});