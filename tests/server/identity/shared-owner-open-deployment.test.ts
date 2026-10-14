import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveSharedOwnerId,
  sharedOwnerWithoutAccessCodeAllowed,
} from '@/lib/server/identity/shared-team';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('shared owner without an access-code gate', () => {
  it('is refused when the operator has not acknowledged having no gate', () => {
    vi.stubEnv('ACCESS_CODE', '');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', 'team-alpha');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ALLOW_OPEN', '');

    expect(() => resolveSharedOwnerId()).toThrow(/ACCESS_CODE/);
  });

  it('is refused when the acknowledgement is set to anything but true/1', () => {
    vi.stubEnv('ACCESS_CODE', '');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', 'team-alpha');

    for (const value of ['false', 'yes', 'TRUE', '0']) {
      vi.stubEnv('PERSISTENCE_SHARED_OWNER_ALLOW_OPEN', value);
      expect(sharedOwnerWithoutAccessCodeAllowed()).toBe(false);
      expect(() => resolveSharedOwnerId()).toThrow(/ACCESS_CODE/);
    }
  });

  it('resolves to the shared owner, with a warning, once acknowledged', () => {
    vi.stubEnv('ACCESS_CODE', '');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', 'team-alpha');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ALLOW_OPEN', 'true');
    // The warning goes through the repo logger, which drops anything below its
    // configured level.
    vi.stubEnv('LOG_LEVEL', 'info');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(sharedOwnerWithoutAccessCodeAllowed()).toBe(true);
    expect(resolveSharedOwnerId()).toBe('team-alpha');
    // One-time, and it names the trade rather than the flag.
    expect(warn.mock.calls.flat().join(' ')).toMatch(/PERSISTENCE_SHARED_OWNER_ID/);

    warn.mockRestore();
  });

  it('still requires an access code to be *absent*: a code wins over the acknowledgement', () => {
    vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', 'team-alpha');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ALLOW_OPEN', 'true');

    expect(resolveSharedOwnerId()).toBe('team-alpha');
  });

  it('changes nothing when there is no shared owner at all', () => {
    vi.stubEnv('ACCESS_CODE', '');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ALLOW_OPEN', 'true');

    expect(resolveSharedOwnerId()).toBeUndefined();
  });
});
