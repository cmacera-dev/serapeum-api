import { describe, it, expect, vi, beforeEach } from 'vitest';
import { orchestratorFlow } from '@/flows/agent/orchestratorFlow.js';

// Mock the AI library (same pattern as orchestratorFlow.test.ts)
vi.mock('@/lib/ai', () => {
  const mockSchema = {
    parse: (data: any) => data,
    describe: () => mockSchema,
    optional: () => mockSchema,
    nullable: () => mockSchema,
    passthrough: () => mockSchema,
    or: () => mockSchema,
    and: () => mockSchema,
    default: () => mockSchema,
  };

  return {
    ai: {
      defineFlow: (_config: any, fn: any) => fn,
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
      infer: {} as any,
    },
    activeModel: 'mock-model',
  };
});

// Mock catalog flows
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

// Mock tools
vi.mock('@/tools/search-tavily-tool', () => ({ searchTavilyTool: vi.fn().mockResolvedValue([]) }));

// Mock prompts
vi.mock('@/prompts/routerPrompt', () => ({ routerPrompt: vi.fn() }));
vi.mock('@/prompts/extractorPrompt', () => ({ extractorPrompt: vi.fn() }));
vi.mock('@/prompts/synthesizerPrompt', () => ({ synthesizerPrompt: vi.fn() }));

// Mock queryCache so we control hit/miss without a real Supabase
vi.mock('@/lib/queryCache.js', () => ({
  generateCacheKey: vi.fn().mockReturnValue('deadbeefcafe0000'),
  getCachedResponse: vi.fn(),
  cacheAsync: vi.fn().mockImplementation((_key: string, response: unknown) => response),
}));

import { routerPrompt } from '@/prompts/routerPrompt.js';
import { synthesizerPrompt } from '@/prompts/synthesizerPrompt.js';
import { searchAll } from '@/flows/catalog/searchAll.js';
import { getCachedResponse, cacheAsync } from '@/lib/queryCache.js';

const cachedResponse = {
  kind: 'search_results' as const,
  message: 'Cached result for Inception',
  data: {
    media: [{ title: 'Inception', id: 1, media_type: 'movie' as const }],
    books: [],
    games: [],
  },
  traceId: 'trace-cached',
};

describe('orchestratorFlow — caching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns cached response and skips the pipeline on a cache hit', async () => {
    vi.mocked(getCachedResponse).mockResolvedValue(cachedResponse);

    const result = await orchestratorFlow({ query: 'Tell me about Inception', language: 'en' });

    expect(result).toEqual(cachedResponse);
    expect(routerPrompt).not.toHaveBeenCalled();
    expect(searchAll).not.toHaveBeenCalled();
    expect(synthesizerPrompt).not.toHaveBeenCalled();
  });

  it('runs the pipeline and writes to cache on a cache miss', async () => {
    vi.mocked(getCachedResponse).mockResolvedValue(null);

    (routerPrompt as any).mockResolvedValue({
      output: {
        intent: 'SPECIFIC_ENTITY',
        category: 'MOVIE_TV',
        extractedQuery: 'Inception',
      },
    });

    (searchAll as any).mockResolvedValue({
      media: [{ title: 'Inception', id: 1, media_type: 'movie' }],
      books: [],
      games: [],
    });

    (synthesizerPrompt as any).mockResolvedValue({
      text: 'Inception is a 2010 sci-fi thriller.',
    });

    const result = await orchestratorFlow({ query: 'Tell me about Inception', language: 'en' });

    expect(result).toHaveProperty('kind', 'search_results');
    expect(routerPrompt).toHaveBeenCalledOnce();
    expect(cacheAsync).toHaveBeenCalledOnce();
    expect(cacheAsync).toHaveBeenCalledWith(
      'deadbeefcafe0000',
      expect.objectContaining({ kind: 'search_results' }),
      // Nothing failed on the way here, so the answer is offered to the cache as sound.
      // What happens when something did fail is covered in orchestratorFlowDegradedCache.
      { degraded: false }
    );
  });

  it('does not write to cache when the pipeline returns an error response', async () => {
    vi.mocked(getCachedResponse).mockResolvedValue(null);

    // Router returns null → triggers error path
    (routerPrompt as any).mockResolvedValue({ output: null });

    const result = await orchestratorFlow({ query: 'Tell me about Inception', language: 'en' });

    expect(result).toHaveProperty('kind', 'error');
    expect(cacheAsync).not.toHaveBeenCalled();
  });

  it('pipeline runs exactly once across two identical requests when the second is a cache hit', async () => {
    // First call: cache miss → run pipeline
    vi.mocked(getCachedResponse).mockResolvedValueOnce(null);

    (routerPrompt as any).mockResolvedValue({
      output: {
        intent: 'SPECIFIC_ENTITY',
        category: 'MOVIE_TV',
        extractedQuery: 'Inception',
      },
    });

    (searchAll as any).mockResolvedValue({
      media: [{ title: 'Inception', id: 1, media_type: 'movie' }],
      books: [],
      games: [],
    });

    (synthesizerPrompt as any).mockResolvedValue({ text: 'Inception is great.' });

    await orchestratorFlow({ query: 'Tell me about Inception', language: 'en' });

    // Second call: cache hit → skip pipeline
    vi.mocked(getCachedResponse).mockResolvedValueOnce(cachedResponse);

    const secondResult = await orchestratorFlow({
      query: 'Tell me about Inception',
      language: 'en',
    });

    expect(secondResult).toEqual(cachedResponse);
    // routerPrompt was called only for the first request
    expect(routerPrompt).toHaveBeenCalledOnce();
  });
});
