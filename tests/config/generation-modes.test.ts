/**
 * The mode table itself — the one place a mode's meaning is written down.
 *
 * Two very different consumers read this: the classic course path resolves a
 * request to an OUTLINE POLICY it then coerces in code, and the workbench reads
 * the mode to state and enforce the same shape page by page. Neither is tested
 * against the table's wording elsewhere, so the mapping is pinned here.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_GENERATION_MODE,
  GENERATION_MODES,
  GENERATION_MODE_SLUGS,
  envFallbackGenerationMode,
  isGenerationMode,
  parseGenerationMode,
  resolveGenerationMode,
  resolveOutlinePolicy,
} from '@/lib/config/generation-modes';
import { generationModePromptBlock } from '@/lib/server/agent-runtime/generation-mode-prompt';
import type { GenerationMode } from '@/lib/types/generation';

describe('parseGenerationMode', () => {
  it('accepts every canonical id', () => {
    for (const mode of GENERATION_MODES) expect(parseGenerationMode(mode)).toBe(mode);
  });

  it('accepts the URL slugs the entry links use', () => {
    // The links handed out are `/classic`, `/game`, `/games`; whoever copies a
    // link into a request is naming the mode by the address they are standing on.
    expect(parseGenerationMode('game')).toBe('single-game');
    expect(parseGenerationMode('games')).toBe('multi-game');
    expect(parseGenerationMode('classic')).toBe('classic');
  });

  it('maps the legacy pbl spelling onto multi-game', () => {
    expect(parseGenerationMode('pbl')).toBe('multi-game');
  });

  it('returns null for anything else, so the caller owns the fallback', () => {
    for (const value of ['', '  ', 'CLASSIC!', 'hologram', null, undefined, 42, {}, []]) {
      expect(parseGenerationMode(value)).toBeNull();
    }
  });

  it('tolerates surrounding whitespace and case, as a URL would carry it', () => {
    expect(parseGenerationMode(' SINGLE-GAME ')).toBe('single-game');
  });

  it('agrees with isGenerationMode on the canonical ids only', () => {
    expect(isGenerationMode('single-game')).toBe(true);
    expect(isGenerationMode('game')).toBe(false);
  });
});

describe('entry-link slugs', () => {
  it('covers every mode, and only those', () => {
    expect(Object.keys(GENERATION_MODE_SLUGS).sort()).toEqual([...GENERATION_MODES].sort());
    // Each slug must round-trip back to its mode through the parser.
    for (const mode of GENERATION_MODES) {
      expect(parseGenerationMode(GENERATION_MODE_SLUGS[mode])).toBe(mode);
    }
  });
});

describe('resolveGenerationMode', () => {
  it('prefers an explicit mode over the deployment fallback', () => {
    vi.stubEnv('OPENMAIC_SINGLE_GAME_MODE', 'true');
    try {
      expect(resolveGenerationMode({ generationMode: 'multi-game' })).toBe('multi-game');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('falls back to classic when the flag is unset and nothing was requested', () => {
    expect(envFallbackGenerationMode()).toBe(DEFAULT_GENERATION_MODE);
    expect(resolveGenerationMode(undefined)).toBe('classic');
    expect(resolveGenerationMode(null)).toBe('classic');
  });

  it('treats a stale client value as absent rather than as an error', () => {
    vi.stubEnv('OPENMAIC_SINGLE_GAME_MODE', 'true');
    try {
      expect(resolveGenerationMode({ generationMode: 'from-the-future' as GenerationMode })).toBe(
        'single-game',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('resolveOutlinePolicy', () => {
  it('caps ② at one scene and streams only that scene', () => {
    const policy = resolveOutlinePolicy('single-game');
    expect(policy.maxScenes).toBe(1);
    expect(policy.forceGameScenes).toBe(true);
    expect(policy.streamFirstSceneOnly).toBe(true);
    expect(policy.promptId).toBe('single-game-outlines');
  });

  it('forces games in ③ but leaves the scene count to the model', () => {
    const policy = resolveOutlinePolicy('multi-game');
    expect(policy.maxScenes).toBeUndefined();
    expect(policy.forceGameScenes).toBe(true);
    expect(policy.streamFirstSceneOnly).toBe(false);
  });

  it('leaves ① alone', () => {
    const policy = resolveOutlinePolicy('classic');
    expect(policy.promptId).toBeNull();
    expect(policy.forceGameScenes).toBe(false);
    expect(policy.maxScenes).toBeUndefined();
    expect(policy.streamFirstSceneOnly).toBe(false);
  });
});

describe('generationModePromptBlock', () => {
  it('says nothing for classic, whose prompt is unchanged by definition', () => {
    expect(generationModePromptBlock('classic')).toBe('');
    expect(generationModePromptBlock(undefined)).toBe('');
  });

  it('states ② as exactly one page, whatever the material weighs', () => {
    const block = generationModePromptBlock('single-game');
    expect(block).toContain('exactly ONE page');
    // The failure the prompt has to prevent is expansion, so the rule that
    // blocks it must be present verbatim in spirit.
    expect(block.toLowerCase()).toContain('does not change');
    expect(block).toContain('widgetType: "game"');
  });

  it('states ③ as one page per objective', () => {
    const block = generationModePromptBlock('multi-game');
    expect(block).toContain('one page per teaching objective');
    expect(block).toContain('seriesTotal');
    expect(block).toContain('seriesIndex');
  });

  it('tells ② not to declare a series, and ③ to always declare one', () => {
    // The pair drives which contract the widget template renders, so a wrong
    // declaration is a wrong product rather than a cosmetic slip.
    expect(generationModePromptBlock('single-game')).toContain('Do not pass `seriesIndex`');
    expect(generationModePromptBlock('multi-game')).toContain('Declare the series size');
  });
});