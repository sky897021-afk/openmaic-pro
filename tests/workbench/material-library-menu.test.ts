// @vitest-environment jsdom

/**
 * The library picker, as a component.
 *
 * What is pinned here is the popover's contract with its surface — one exit for
 * Escape / an outside press / a pick, rows already on the turn staying visible
 * but dead, and a failed load offering a retry rather than an empty list. The
 * grammar of WHICH popover is open (`resolveComposerMenu`) is tested in
 * `composer-menus.test.ts`; the count rules in `composer-materials-toast`.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { WorkbenchMaterial } from '@/lib/workbench/session-store';

// The keys ARE the assertions: this picks the copy without dragging i18next in.
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en-US' }),
}));

const roots: Root[] = [];

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  // jsdom has no layout, so it does not implement this. The menu calls it to
  // keep the highlighted row in view while arrowing.
  Element.prototype.scrollIntoView = vi.fn();
});

function ownerRow(overrides: Record<string, unknown> = {}) {
  return {
    materialId: 'mat_a',
    kind: 'source',
    mime: 'text/markdown',
    bytes: 10,
    originalName: '手册.md',
    extraction: { status: 'idle' },
    createdAt: '2023-11-14T22:13:20.000Z',
    ...overrides,
  };
}

/** A fetch that answers the library route and nothing else. */
function libraryFetch(rows: unknown[], init?: { status?: number; body?: unknown }): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/materials/library')) {
      return Response.json(
        init?.body ?? { materials: rows },
        init?.status ? { status: init.status } : undefined,
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
}

async function renderMenu({
  props = {},
  fetchImpl,
}: {
  props?: Partial<Parameters<typeof import('@/components/workbench/compose-extras').MaterialLibraryMenu>[0]>;
  fetchImpl: typeof fetch;
} = { fetchImpl: libraryFetch([ownerRow()]) }) {
  vi.stubGlobal('fetch', fetchImpl);
  const { MaterialLibraryMenu } = await import('@/components/workbench/compose-extras');

  const onPick = vi.fn();
  const onDismiss = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  await act(async () => {
    root.render(
      createElement(
        'div',
        { className: 'relative' },
        createElement(MaterialLibraryMenu, {
          title: 'proMode.materialMenuTitle',
          selectedIds: [],
          onPick,
          onDismiss,
          ...props,
        }) as ReactNode,
        // The surface's trigger, rendered as a sibling exactly as the composers
        // do: the popover has to recognise a press aimed at it.
        createElement('button', {
          type: 'button',
          'data-library-trigger': '',
          'data-mention-keep-open': '',
          'data-testid': 'trigger',
        }),
      ),
    );
  });

  return { onPick, onDismiss, container };
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const optionFor = (materialId: string) => byTestId(`workbench-material-option-${materialId}`);

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the material library menu', () => {
  it('lists the library and reports a pick', async () => {
    const { onPick } = await renderMenu({ fetchImpl: libraryFetch([ownerRow()]) });

    await act(async () => {
      await vi.waitFor(() => expect(optionFor('mat_a')).not.toBeNull());
    });
    expect(optionFor('mat_a')?.textContent).toContain('手册.md');

    await act(async () => optionFor('mat_a')!.click());
    expect(onPick).toHaveBeenCalledWith({
      materialId: 'mat_a',
      name: '手册.md',
      bytes: 10,
      mimeType: 'text/markdown',
      extractionStatus: 'idle',
    } satisfies WorkbenchMaterial);
  });

  it('shows a material already on the turn, but will not pick it again', async () => {
    const { onPick } = await renderMenu({
      fetchImpl: libraryFetch([ownerRow()]),
      props: { selectedIds: ['mat_a'] },
    });

    await act(async () => {
      await vi.waitFor(() => expect(optionFor('mat_a')).not.toBeNull());
    });
    const option = optionFor('mat_a') as HTMLButtonElement;
    expect(option.disabled).toBe(true);
    expect(option.getAttribute('aria-disabled')).toBe('true');
    // Still visible: the reader can see what is on the turn rather than
    // wondering where the material went.
    expect(option.textContent).toContain('proMode.materialAttached');

    await act(async () => option.click());
    expect(onPick).not.toHaveBeenCalled();
  });

  it('says the library is empty rather than showing nothing', async () => {
    await renderMenu({ fetchImpl: libraryFetch([]) });

    await act(async () => {
      await vi.waitFor(() =>
        expect(byTestId('workbench-material-menu')?.textContent).toContain(
          'proMode.noMaterialsAvailable',
        ),
      );
    });
  });

  it('offers a retry when the load failed, and refetches on it', async () => {
    let attempts = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.includes('/api/materials/library')) throw new Error(`unexpected fetch ${url}`);
      attempts += 1;
      return attempts === 1
        ? Response.json({ message: 'boom' }, { status: 500 })
        : Response.json({ materials: [ownerRow()] });
    }) as unknown as typeof fetch;
    await renderMenu({ fetchImpl });

    await act(async () => {
      await vi.waitFor(() =>
        expect(byTestId('workbench-material-menu')?.textContent).toContain(
          'proMode.materialsLoadFailed',
        ),
      );
    });

    const retry = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'proMode.retryMaterials',
    );
    expect(retry).toBeDefined();
    await act(async () => retry!.click());

    await act(async () => {
      await vi.waitFor(() => expect(optionFor('mat_a')).not.toBeNull());
    });
    expect(attempts).toBe(2);
  });

  it('closes on Escape, from inside the menu or from its own trigger', async () => {
    const { onDismiss } = await renderMenu({ fetchImpl: libraryFetch([ownerRow()]) });
    await act(async () => {
      await vi.waitFor(() => expect(optionFor('mat_a')).not.toBeNull());
    });

    optionFor('mat_a')!.focus();
    await act(async () => {
      optionFor('mat_a')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);

    // The trigger holds focus right after the click that opened the menu, so
    // its own Escape has to count too.
    byTestId('trigger')!.focus();
    await act(async () => {
      byTestId('trigger')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it('picks the highlighted row on Enter', async () => {
    const { onPick } = await renderMenu({
      fetchImpl: libraryFetch([
        ownerRow({ materialId: 'mat_a', originalName: 'a.md' }),
        ownerRow({ materialId: 'mat_b', originalName: 'b.md' }),
      ]),
    });
    await act(async () => {
      await vi.waitFor(() => expect(optionFor('mat_a')).not.toBeNull());
    });

    await act(async () => {
      optionFor('mat_a')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    await act(async () => {
      optionFor('mat_a')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]?.[0]).toMatchObject({ materialId: 'mat_b' });
  });

  it('closes on a press outside, but not on a press on its own trigger', async () => {
    const { onDismiss } = await renderMenu({ fetchImpl: libraryFetch([ownerRow()]) });
    await act(async () => {
      await vi.waitFor(() => expect(optionFor('mat_a')).not.toBeNull());
    });

    // The trigger: the press that opens the menu must not also close it.
    await act(async () => {
      byTestId('trigger')!.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    });
    expect(onDismiss).not.toHaveBeenCalled();

    const outside = document.createElement('div');
    document.body.append(outside);
    await act(async () => {
      outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not swallow keys aimed somewhere else on the page', async () => {
    const { onPick } = await renderMenu({ fetchImpl: libraryFetch([ownerRow()]) });
    await act(async () => {
      await vi.waitFor(() => expect(optionFor('mat_a')).not.toBeNull());
    });

    const outside = document.createElement('input');
    document.body.append(outside);
    outside.focus();
    await act(async () => {
      outside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(onPick).not.toHaveBeenCalled();
  });
});