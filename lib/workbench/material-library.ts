'use client';

/**
 * The shared material library, as the composer sees it.
 *
 * Sibling of `lib/workbench/agent-skills` — that module owns the Skill registry
 * the `/` menu reads; this one owns the owner's uploaded materials, which the
 * library picker reads. It lives here rather than inside `compose-extras` for
 * the same reason the skill registry does: the composer module is the upload
 * machinery, and nothing that only wants to LIST should have to pull it in.
 *
 * Unlike the skill registry there is no module-level cache. The picker is
 * mounted only while it is open, so mounting IS opening: refetching each time
 * is what makes a material uploaded a minute ago show up, and the owner
 * library is a small table behind a single indexed query.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  listWorkbenchLibraryMaterials,
  type WorkbenchMaterial,
} from '@/lib/workbench/session-store';

export interface LibrarySnapshot {
  materials: WorkbenchMaterial[];
  loading: boolean;
  /** Set when the load failed; the picker offers a retry. */
  error: unknown;
}

export function useLibraryMaterials(): LibrarySnapshot & { reload: () => Promise<void> } {
  const [snapshot, setSnapshot] = useState<LibrarySnapshot>({
    materials: [],
    loading: true,
    error: null,
  });
  // One flag per mount: a settled promise for an unmounted picker must not
  // write state (React would warn, and a reopened picker would show the old
  // request's result before its own).
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setSnapshot((current) => ({ ...current, loading: true, error: null }));
    try {
      const materials = await listWorkbenchLibraryMaterials();
      if (!alive.current) return;
      setSnapshot({ materials, loading: false, error: null });
    } catch (error) {
      if (!alive.current) return;
      // Keep whatever was already listed rather than blanking the picker: a
      // failed refresh is not a reason to hide the rows the reader can still
      // pick, and the retry affordance carries the failure.
      setSnapshot((current) => ({ ...current, loading: false, error }));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { ...snapshot, reload: load };
}