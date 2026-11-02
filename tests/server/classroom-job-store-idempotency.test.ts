import { promises as fs } from 'node:fs';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const jobsDir = vi.hoisted(
  () => `${process.cwd()}/data/.test-classroom-jobs-${process.pid}-${Date.now()}`,
);

vi.mock('@/lib/server/classroom-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/classroom-storage')>();
  return {
    ...actual,
    CLASSROOM_JOBS_DIR: jobsDir,
    ensureClassroomJobsDir: async () => {
      await fs.mkdir(jobsDir, { recursive: true });
    },
  };
});

describe('createClassroomGenerationJobIfAbsent', () => {
  beforeEach(async () => {
    vi.resetModules();
    await fs.rm(jobsDir, { recursive: true, force: true });
    await fs.mkdir(jobsDir, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(jobsDir, { recursive: true, force: true });
  });

  it('allows exactly one concurrent caller to claim the job', async () => {
    const { createClassroomGenerationJobIfAbsent, readClassroomGenerationJob } =
      await import('@/lib/server/classroom-job-store');
    const input = { requirement: 'Concurrent idempotency check' };

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        createClassroomGenerationJobIfAbsent('int_concurrent_job', input),
      ),
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.every((result) => result.job.id === 'int_concurrent_job')).toBe(true);
    const stored = await readClassroomGenerationJob('int_concurrent_job');
    expect(stored).toMatchObject({
      id: 'int_concurrent_job',
      status: 'queued',
      inputSummary: {
        requirementPreview: 'Concurrent idempotency check',
      },
    });
  });
});
