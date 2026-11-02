/**
 * Client-side handoff plumbing shared by the `/game?handoff=` landing and the
 * generation preview.
 *
 * The landing stores the handoff id and completion token in sessionStorage;
 * the preview reports the finished stage back. Keeping the keys here means the
 * two surfaces cannot drift on storage names.
 */
const HANDOFF_ID_KEY = 'maic:integration-handoff-id';
const HANDOFF_TOKEN_KEY = 'maic:integration-handoff-token';

export function storeHandoffSession(handoffId: string, completionToken: string): void {
  if (typeof window === 'undefined') return;
  sessionStorage.setItem(HANDOFF_ID_KEY, handoffId);
  sessionStorage.setItem(HANDOFF_TOKEN_KEY, completionToken);
}

/**
 * Tell the platform integration which stage the handoff produced. Never throws:
 * the generated course exists even if this report fails, and blocking the
 * classroom navigation on it would be worse than a handoff left pending.
 */
export async function reportHandoffResult(stageId: string): Promise<void> {
  if (typeof window === 'undefined') return;
  const handoffId = sessionStorage.getItem(HANDOFF_ID_KEY);
  const completionToken = sessionStorage.getItem(HANDOFF_TOKEN_KEY);
  if (!handoffId || !completionToken) return;

  try {
    const response = await fetch(
      `/api/integration/v1/handoffs/${encodeURIComponent(handoffId)}/result`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          completionToken,
          stageId,
        }),
        keepalive: true,
      },
    );
    if (!response.ok) {
      // Keep the write capability so the completion report can be retried.
      return;
    }
  } catch {
    // Leave the handoff pending; it expires with the material records.
    return;
  }
  sessionStorage.removeItem(HANDOFF_ID_KEY);
  sessionStorage.removeItem(HANDOFF_TOKEN_KEY);
}
