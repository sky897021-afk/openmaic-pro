/**
 * The embedding client for the owner knowledge base.
 *
 * ## Configuration
 *
 * `KNOWLEDGE_BASE_EMBEDDING_MODEL` is a `provider:model` string parsed by the
 * same `parseModelString` every other model reference in this codebase goes
 * through, and its credentials are resolved by the same
 * `resolveApiKey`/`resolveBaseUrl` pair — so an operator who has already
 * configured a provider for chat has configured it here too, and no second
 * place exists to hold a key. Unset means the feature is off: there is
 * deliberately no hardcoded default model, matching `resolveModel`'s own
 * refusal to pick a vendor for the operator.
 *
 * ## Why the whole index is built through one function
 *
 * A vector is only meaningful against other vectors from the SAME model. If the
 * query is embedded by one model and the chunks by another, cosine similarity
 * does not fail — it returns a number, and the ranking it produces is
 * meaningless while looking perfectly healthy. So the model id travels with
 * every vector it produced (see `owner_knowledge_document.model`), and reads
 * filter on it.
 */
import { parseModelString } from '@/lib/ai/providers';
import { fetchWithRedirectValidation } from '@/lib/server/fetch-with-redirect-validation';
import { resolveApiKey, resolveBaseUrl } from '@/lib/server/provider-config';

/** Inputs per request. Large enough to amortize the round trip, small enough
 * that one oversized document cannot build a request the endpoint rejects. */
const EMBED_BATCH_SIZE = 16;
/** Characters per request, independent of the batch count. */
const EMBED_BATCH_CHARS = 24_000;
const EMBED_TIMEOUT_MS = 60_000;
const EMBED_MAX_ATTEMPTS = 3;
const EMBED_RETRY_BASE_MS = 500;

export class KnowledgeBaseEmbeddingError extends Error {
  constructor(
    message: string,
    readonly transient = false,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'KnowledgeBaseEmbeddingError';
  }
}

export interface EmbeddingConnection {
  providerId: string;
  modelId: string;
  apiKey: string;
  baseUrl: string;
  /** The `provider:model` string, recorded on the indexed document. */
  route: string;
}

/** The configured embedding route, or `null` when this deployment has none. */
export function resolveEmbeddingConnection(): EmbeddingConnection | null {
  const configured = process.env.KNOWLEDGE_BASE_EMBEDDING_MODEL?.trim();
  if (!configured) return null;
  let providerId: string;
  let modelId: string;
  try {
    ({ providerId, modelId } = parseModelString(configured));
  } catch {
    return null;
  }
  if (!providerId || !modelId) return null;
  const apiKey = resolveApiKey(providerId);
  const baseUrl = resolveBaseUrl(providerId);
  // A route without a reachable endpoint is not a configured capability. The
  // empty-key case is refused too: an OpenAI-compatible server that ignores
  // auth still expects the header, and a deployment that genuinely needs no key
  // can set any non-empty value.
  if (!baseUrl || !apiKey) return null;
  return { providerId, modelId, apiKey, baseUrl, route: `${providerId}:${modelId}` };
}

export function hasConfiguredKnowledgeBaseEmbedding(): boolean {
  return resolveEmbeddingConnection() !== null;
}

interface EmbeddingsResponse {
  data?: Array<{ index?: number; embedding?: unknown }>;
  error?: { message?: string };
}

function embeddingsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/embeddings`;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** One request. Returns the vectors in the order they were sent. */
async function embedBatch(
  connection: EmbeddingConnection,
  inputs: readonly string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  const response = await fetchWithRedirectValidation(embeddingsUrl(connection.baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${connection.apiKey}`,
    },
    body: JSON.stringify({
      model: connection.modelId,
      input: inputs,
      encoding_format: 'float',
    }),
    signal: signal ?? AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new KnowledgeBaseEmbeddingError(
      `embedding endpoint answered ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
      response.status === 429 || response.status >= 500,
    );
  }

  const body = (await response.json().catch(() => null)) as EmbeddingsResponse | null;
  if (body?.error?.message) {
    throw new KnowledgeBaseEmbeddingError(`embedding endpoint refused the request: ${body.error.message}`);
  }
  const data = body?.data;
  if (!Array.isArray(data) || data.length !== inputs.length) {
    throw new KnowledgeBaseEmbeddingError(
      `embedding endpoint returned ${Array.isArray(data) ? data.length : 0} vectors for ${inputs.length} inputs`,
    );
  }
  // The response carries an `index` per vector; honoring it is what makes the
  // batch usable even if a server ever returns them out of order, and the
  // alternative — trusting array position — would silently pair a chunk with
  // another chunk's vector, which no later check could detect.
  const ordered: number[][] = new Array(inputs.length);
  for (const [position, entry] of data.entries()) {
    const index = typeof entry.index === 'number' && Number.isInteger(entry.index) ? entry.index : position;
    if (index < 0 || index >= inputs.length || ordered[index]) {
      throw new KnowledgeBaseEmbeddingError(
        `embedding endpoint returned an out-of-range or duplicate index ${index}`,
      );
    }
    if (!Array.isArray(entry.embedding) || entry.embedding.length === 0) {
      throw new KnowledgeBaseEmbeddingError('embedding endpoint returned an empty vector');
    }
    const vector = entry.embedding.map((value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0));
    ordered[index] = vector;
  }
  const dimension = ordered[0]!.length;
  for (const vector of ordered) {
    if (vector.length !== dimension) {
      throw new KnowledgeBaseEmbeddingError(
        `embedding endpoint returned vectors of differing widths (${dimension} and ${vector.length})`,
      );
    }
  }
  return ordered;
}

/**
 * Embed a batch of texts, preserving order.
 *
 * Batches by input count AND by characters, because both ceilings are real:
 * a server rejects an over-long input individually, and rejects an over-long
 * request as a whole. Retries are bounded and only for the transient class —
 * a 400 from a misconfigured model is the operator's error and repeats
 * identically, so retrying it just delays the report.
 */
export async function embedTexts(
  texts: readonly string[],
  options: { signal?: AbortSignal } = {},
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const connection = resolveEmbeddingConnection();
  if (!connection) {
    throw new KnowledgeBaseEmbeddingError(
      'KNOWLEDGE_BASE_EMBEDDING_MODEL is not configured for this deployment',
    );
  }

  const batches: string[][] = [];
  let current: string[] = [];
  let currentChars = 0;
  for (const text of texts) {
    // A single input over the character ceiling still goes alone; the endpoint
    // is the authority on what it accepts, and refusing it here would report a
    // local guess as the reason.
    if (current.length > 0 && (current.length >= EMBED_BATCH_SIZE || currentChars + text.length > EMBED_BATCH_CHARS)) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(text);
    currentChars += text.length;
  }
  if (current.length > 0) batches.push(current);

  const vectors: number[][] = [];
  for (const batch of batches) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= EMBED_MAX_ATTEMPTS; attempt += 1) {
      try {
        vectors.push(...(await embedBatch(connection, batch, options.signal)));
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        const transient = error instanceof KnowledgeBaseEmbeddingError && error.transient;
        if (!transient || attempt === EMBED_MAX_ATTEMPTS) break;
        await sleep(EMBED_RETRY_BASE_MS * 2 ** (attempt - 1));
      }
    }
    if (lastError !== undefined) throw lastError;
  }
  return vectors;
}

/** Embed one string — the retrieval side of the same model. */
export async function embedQuery(text: string, options: { signal?: AbortSignal } = {}): Promise<number[]> {
  const [vector] = await embedTexts([text], options);
  if (!vector) throw new KnowledgeBaseEmbeddingError('embedding endpoint returned no vector');
  return vector;
}