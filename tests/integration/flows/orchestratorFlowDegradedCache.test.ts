import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { orchestratorFlow } from '@/flows/agent/orchestratorFlow.js';

/**
 * What reaches the shared cache, with the real `queryCache` module loaded.
 *
 * `orchestratorFlowCache.test.ts` cannot cover this: it `vi.mock()`s `@/lib/queryCache.js` at
 * file level, so the gate under test here is stubbed out there. Hence a separate file that
 * mocks everything *except* the cache and watches the Supabase REST calls.
 *
 * The defect being pinned: the gate used to be `kind !== 'error'`, a test of shape. Every
 * degraded path passes it — a synthesizer that threw leaves the locale's fallback sentence in
 * place and still answers `search_results` — so a transient provider failure was written to
 * the shared cache and served to every caller for the full TTL (86400s by default), with
 * nothing in the codebase able to invalidate it.
 */

vi.mock('@/lib/ai', () => {
  const mockSchema: Record<string, unknown> = {};
  Object.assign(mockSchema, {
    parse: (data: unknown) => data,
    describe: () => mockSchema,
    optional: () => mockSchema,
    nullable: () => mockSchema,
    passthrough: () => mockSchema,
    or: () => mockSchema,
    and: () => mockSchema,
    default: () => mockSchema,
  });

  return {
    ai: {
      defineFlow: (_config: unknown, fn: unknown) => fn,
      defineSchema: vi.fn(),
      prompt: vi.fn().mockReturnValue(vi.fn()),
    },
    z: {
      object: () => mockSchema,
      string: () => mockSchema,
      number: () => mockSchema,
      boolean: () => mockSchema,
      enum: () => mockSchema,
      union: () => mockSchema,
      array: () => mockSchema,
      unknown: () => mockSchema,
      record: () => mockSchema,
      any: () => mockSchema,
      literal: () => mockSchema,
      discriminatedUnion: () => mockSchema,
      infer: {},
    },
    activeModel: 'mock-model',
  };
});

vi.mock('@/flows/catalog/searchAll', () => ({
  searchAll: vi.fn().mockResolvedValue({ media: [], books: [], games: [] }),
}));
vi.mock('@/flows/catalog/searchMedia', () => ({ searchMedia: vi.fn().mockResolvedValue([]) }));
vi.mock('@/flows/catalog/searchGames', () => ({ searchGames: vi.fn().mockResolvedValue([]) }));
vi.mock('@/flows/catalog/searchBooks', () => ({ searchBooks: vi.fn().mockResolvedValue([]) }));
vi.mock('@/flows/catalog/getMovieDetail', () => ({
  getMovieDetail: vi.fn().mockResolvedValue({}),
}));
vi.mock('@/flows/catalog/getTvDetail', () => ({ getTvDetail: vi.fn().mockResolvedValue({}) }));
vi.mock('@/tools/search-tavily-tool', () => ({ searchTavilyTool: vi.fn().mockResolvedValue([]) }));
vi.mock('@/prompts/routerPrompt', () => ({ routerPrompt: vi.fn() }));
vi.mock('@/prompts/extractorPrompt', () => ({ extractorPrompt: vi.fn() }));
vi.mock('@/prompts/synthesizerPrompt', () => ({ synthesizerPrompt: vi.fn() }));

import { routerPrompt } from '@/prompts/routerPrompt.js';
import { extractorPrompt } from '@/prompts/extractorPrompt.js';
import { synthesizerPrompt } from '@/prompts/synthesizerPrompt.js';
import { searchAll } from '@/flows/catalog/searchAll.js';

interface CacheWrite {
  key: string;
  kind: string;
  message: string;
}

let writes: CacheWrite[] = [];
let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` forgets the calls but keeps the implementations, and one case below
  // makes the catalog fail — so the healthy default has to be put back each time.
  vi.mocked(searchAll).mockResolvedValue({ media: [], books: [], games: [] } as never);
  writes = [];
  realFetch = globalThis.fetch;

  vi.stubEnv('SUPABASE_URL', 'http://127.0.0.1:1');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'dummy');
  vi.stubEnv('CACHE_TTL_SECONDS', '60');

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST') {
      const body = JSON.parse(String(init?.body)) as {
        key: string;
        response: { kind: string; message?: string };
      };
      writes.push({
        key: body.key,
        kind: body.response.kind,
        message: body.response.message ?? '',
      });
      return new Response('', { status: 201 });
    }
    // Every case here is a cache miss.
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
});

/** The cache write is fire-and-forget, so give it a turn to land before asserting. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

const specificEntity = { intent: 'SPECIFIC_ENTITY', category: 'ALL', extractedQuery: 'Inception' };
const generalDiscovery = {
  intent: 'GENERAL_DISCOVERY',
  category: 'ALL',
  extractedQuery: 'cozy games',
};

describe('orchestratorFlow — what gets cached', () => {
  it('caches a healthy answer', async () => {
    vi.mocked(routerPrompt).mockResolvedValue({ output: specificEntity } as never);
    vi.mocked(synthesizerPrompt).mockResolvedValue({
      text: 'Inception is a 2010 thriller.',
    } as never);

    const result = await orchestratorFlow({ query: 'tell me about inception', language: 'en' });
    await settle();

    expect(result).toHaveProperty('kind', 'search_results');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.message).toBe('Inception is a 2010 thriller.');
  });

  it('does not cache Path A when the synthesizer throws', async () => {
    vi.mocked(routerPrompt).mockResolvedValue({ output: specificEntity } as never);
    vi.mocked(synthesizerPrompt).mockRejectedValue(new Error('model exploded'));

    const result = await orchestratorFlow({ query: 'tell me about inception', language: 'en' });
    await settle();

    // The caller still gets the fallback sentence — it just is not pinned for everyone else.
    expect(result).toHaveProperty('kind', 'search_results');
    expect(writes).toEqual([]);
  });

  it('does not cache Path A when the synthesizer returns empty text', async () => {
    vi.mocked(routerPrompt).mockResolvedValue({ output: specificEntity } as never);
    vi.mocked(synthesizerPrompt).mockResolvedValue({ text: '   ' } as never);

    await orchestratorFlow({ query: 'tell me about inception', language: 'en' });
    await settle();

    expect(writes).toEqual([]);
  });

  it('does not cache Path A when a catalog source failed', async () => {
    vi.mocked(routerPrompt).mockResolvedValue({ output: specificEntity } as never);
    vi.mocked(searchAll).mockResolvedValue({
      media: [],
      books: [],
      games: [],
      errors: [{ source: 'media', message: 'TMDB API error (500)' }],
    } as never);
    vi.mocked(synthesizerPrompt).mockResolvedValue({ text: 'Here is a partial answer.' } as never);

    await orchestratorFlow({ query: 'tell me about inception', language: 'en' });
    await settle();

    expect(writes).toEqual([]);
  });

  it('does not cache Path B when the synthesizer throws', async () => {
    vi.mocked(routerPrompt).mockResolvedValue({ output: generalDiscovery } as never);
    vi.mocked(extractorPrompt).mockResolvedValue({
      output: { titles: ['Stardew Valley'] },
    } as never);
    vi.mocked(synthesizerPrompt).mockRejectedValue(new Error('model exploded'));

    const result = await orchestratorFlow({ query: 'recommend cozy games', language: 'en' });
    await settle();

    expect(result).toHaveProperty('kind', 'discovery');
    expect(writes).toEqual([]);
  });

  it('caches Path B when everything worked', async () => {
    vi.mocked(routerPrompt).mockResolvedValue({ output: generalDiscovery } as never);
    vi.mocked(extractorPrompt).mockResolvedValue({
      output: { titles: ['Stardew Valley'] },
    } as never);
    vi.mocked(synthesizerPrompt).mockResolvedValue({ text: 'Try Stardew Valley.' } as never);

    await orchestratorFlow({ query: 'recommend cozy games', language: 'en' });
    await settle();

    expect(writes).toHaveLength(1);
    expect(writes[0]?.kind).toBe('discovery');
  });

  it('still caches a refusal, which is a real answer rather than a failure', async () => {
    vi.mocked(routerPrompt).mockResolvedValue({
      output: { intent: 'OUT_OF_SCOPE', category: 'ALL', refusalReason: 'Not my subject.' },
    } as never);

    await orchestratorFlow({ query: 'fix my car', language: 'en' });
    await settle();

    expect(writes).toHaveLength(1);
    expect(writes[0]?.kind).toBe('refusal');
  });

  it('writes nothing at all for an error response', async () => {
    vi.mocked(routerPrompt).mockResolvedValue({ output: generalDiscovery } as never);
    vi.mocked(extractorPrompt).mockRejectedValue(new Error('extractor exploded'));

    const result = await orchestratorFlow({ query: 'recommend cozy games', language: 'en' });
    await settle();

    expect(result).toHaveProperty('kind', 'error');
    expect(writes).toEqual([]);
  });
});
