import 'dotenv/config';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { orchestratorFlow } from '../../../src/flows/agent/orchestratorFlow.js';
import { searchAll } from '../../../src/flows/catalog/searchAll.js';
import { searchMedia } from '../../../src/flows/catalog/searchMedia.js';
import { searchGames } from '../../../src/flows/catalog/searchGames.js';
import { searchBooks } from '../../../src/flows/catalog/searchBooks.js';
import { searchTavilyTool } from '../../../src/tools/search-tavily-tool.js';
import { routerPrompt } from '../../../src/prompts/routerPrompt.js';
import { extractorPrompt } from '../../../src/prompts/extractorPrompt.js';
import { synthesizerPrompt } from '../../../src/prompts/synthesizerPrompt.js';

// Prevent OTEL from injecting a real traceId in tests
vi.mock('@opentelemetry/api', () => ({
  trace: { getActiveSpan: () => undefined },
}));

// Prevent real Supabase calls — cache is transparent in these tests
vi.mock('../../../src/lib/queryCache.js', () => ({
  generateCacheKey: () => 'deadbeefcafe0000',
  getCachedResponse: vi.fn().mockResolvedValue(null),
  cacheAsync: vi.fn().mockImplementation((_key: unknown, response: unknown) => response),
}));

// Mock dependencies
vi.mock('../../../src/lib/ai.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../../src/lib/ai.js')>('../../../src/lib/ai.js');
  return {
    ...actual,
    ai: {
      ...actual.ai,
      generate: vi.fn(),
      defineFlow: actual.ai.defineFlow,
      defineSchema: vi.fn(),
      defineTool: actual.ai.defineTool,
    },
  };
});

vi.mock('../../../src/flows/catalog/searchMedia.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/flows/catalog/searchMedia.js')>(
    '../../../src/flows/catalog/searchMedia.js'
  );
  return {
    ...actual,
    searchMedia: vi.fn(),
  };
});

vi.mock('../../../src/flows/catalog/searchGames.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/flows/catalog/searchGames.js')>(
    '../../../src/flows/catalog/searchGames.js'
  );
  return {
    ...actual,
    searchGames: vi.fn(),
  };
});

vi.mock('../../../src/flows/catalog/searchBooks.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/flows/catalog/searchBooks.js')>(
    '../../../src/flows/catalog/searchBooks.js'
  );
  return {
    ...actual,
    searchBooks: vi.fn(),
  };
});

vi.mock('../../../src/flows/catalog/searchAll.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/flows/catalog/searchAll.js')>(
    '../../../src/flows/catalog/searchAll.js'
  );
  return {
    ...actual,
    searchAll: vi.fn(),
  };
});

vi.mock('../../../src/tools/search-tavily-tool.js', () => ({
  searchTavilyTool: vi.fn(),
}));

// Mock the prompt modules themselves
vi.mock('../../../src/prompts/routerPrompt.js', () => ({
  routerPrompt: vi.fn(),
}));

vi.mock('../../../src/prompts/extractorPrompt.js', () => ({
  extractorPrompt: vi.fn(),
}));

vi.mock('../../../src/prompts/synthesizerPrompt.js', () => ({
  synthesizerPrompt: vi.fn(),
}));

describe('orchestratorFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should be defined', () => {
    expect(orchestratorFlow).toBeDefined();
  });

  it('should enrich search results and feature a media item when intent is SPECIFIC_ENTITY and category is MOVIE_TV', async () => {
    vi.mocked(routerPrompt).mockResolvedValue({
      output: {
        intent: 'SPECIFIC_ENTITY',
        category: 'MOVIE_TV',
        extractedQuery: 'Inception',
      },
    } as Awaited<ReturnType<typeof routerPrompt>>);

    const enrichResult = {
      media: [{ title: 'Inception', id: 1, media_type: 'movie' as const }],
      games: [],
      books: [],
    };
    vi.mocked(searchAll).mockResolvedValue(
      enrichResult as unknown as Awaited<ReturnType<typeof searchAll>>
    );

    vi.mocked(synthesizerPrompt).mockResolvedValue({
      text: 'Mocked synthesizer response for Inception.',
    } as Awaited<ReturnType<typeof synthesizerPrompt>>);

    const result = await orchestratorFlow({ query: 'Movie Inception', language: 'en' });

    expect(routerPrompt).toHaveBeenCalledWith(
      { query: 'Movie Inception', language: 'en' },
      expect.objectContaining({ model: expect.any(String) })
    );
    expect(searchAll).toHaveBeenCalledWith({ query: 'Inception', language: 'en' });
    expect(result).toEqual({
      kind: 'search_results',
      message: 'Mocked synthesizer response for Inception.',
      data: {
        featured: { type: 'media', item: { title: 'Inception', id: 1, media_type: 'movie' } },
        media: [],
        books: [],
        games: [],
      },
    });
  });

  it('should enrich search results and feature a game when intent is SPECIFIC_ENTITY and category is GAME', async () => {
    vi.mocked(routerPrompt).mockResolvedValue({
      output: {
        intent: 'SPECIFIC_ENTITY',
        category: 'GAME',
        extractedQuery: 'Elden Ring',
      },
    } as Awaited<ReturnType<typeof routerPrompt>>);

    const enrichResult = {
      media: [],
      games: [{ name: 'Elden Ring', id: 123 }],
      books: [],
    };
    vi.mocked(searchAll).mockResolvedValue(
      enrichResult as unknown as Awaited<ReturnType<typeof searchAll>>
    );

    vi.mocked(synthesizerPrompt).mockResolvedValue({
      text: 'Mocked synthesizer response for Elden Ring.',
    } as Awaited<ReturnType<typeof synthesizerPrompt>>);

    const result = await orchestratorFlow({ query: 'Game Elden Ring', language: 'en' });

    expect(routerPrompt).toHaveBeenCalledWith(
      { query: 'Game Elden Ring', language: 'en' },
      expect.objectContaining({ model: expect.any(String) })
    );
    expect(searchAll).toHaveBeenCalledWith({ query: 'Elden Ring', language: 'en' });
    expect(result).toEqual({
      kind: 'search_results',
      message: 'Mocked synthesizer response for Elden Ring.',
      data: {
        featured: { type: 'game', item: { name: 'Elden Ring', id: 123 } },
        media: [],
        games: [],
        books: [],
      },
    });
  });

  it('should enrich search results and feature a book when intent is SPECIFIC_ENTITY and category is BOOK', async () => {
    vi.mocked(routerPrompt).mockResolvedValue({
      output: {
        intent: 'SPECIFIC_ENTITY',
        category: 'BOOK',
        extractedQuery: 'Dune',
      },
    } as Awaited<ReturnType<typeof routerPrompt>>);

    const enrichResult = {
      media: [{ title: 'Dune movie', id: 2, media_type: 'movie' as const }],
      games: [],
      books: [{ title: 'Dune', id: '1' }],
    };
    vi.mocked(searchAll).mockResolvedValue(
      enrichResult as unknown as Awaited<ReturnType<typeof searchAll>>
    );

    vi.mocked(synthesizerPrompt).mockResolvedValue({
      text: 'Mocked synthesizer response for Dune.',
    } as Awaited<ReturnType<typeof synthesizerPrompt>>);

    const result = await orchestratorFlow({ query: 'Book Dune', language: 'en' });

    expect(routerPrompt).toHaveBeenCalledWith(
      { query: 'Book Dune', language: 'en' },
      expect.objectContaining({ model: expect.any(String) })
    );
    expect(searchAll).toHaveBeenCalledWith({ query: 'Dune', language: 'en' });
    expect(result).toEqual({
      kind: 'search_results',
      message: 'Mocked synthesizer response for Dune.',
      data: {
        featured: { type: 'book', item: { title: 'Dune', id: '1' } },
        media: enrichResult.media,
        games: [],
        books: [],
      },
    });
  });

  it('should enrich search results and pick best feature when intent is SPECIFIC_ENTITY and category is ALL', async () => {
    vi.mocked(routerPrompt).mockResolvedValue({
      output: {
        intent: 'SPECIFIC_ENTITY',
        category: 'ALL',
        extractedQuery: 'The Witcher',
      },
    } as Awaited<ReturnType<typeof routerPrompt>>);

    const enrichResult = {
      games: [{ name: 'The Witcher 3', id: 10 }],
      media: [{ title: 'The Witcher', id: 20, media_type: 'tv' }], // Exact match wins
      books: [],
    };
    vi.mocked(searchAll).mockResolvedValue(
      enrichResult as unknown as Awaited<ReturnType<typeof searchAll>>
    );

    vi.mocked(synthesizerPrompt).mockResolvedValue({
      text: 'Mocked synthesizer response for The Witcher.',
    } as Awaited<ReturnType<typeof synthesizerPrompt>>);

    const result = await orchestratorFlow({ query: 'Info about The Witcher', language: 'en' });

    expect(routerPrompt).toHaveBeenCalledWith(
      { query: 'Info about The Witcher', language: 'en' },
      expect.objectContaining({ model: expect.any(String) })
    );
    expect(searchAll).toHaveBeenCalledWith({ query: 'The Witcher', language: 'en' });
    expect(synthesizerPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        originalQuery: 'The Witcher',
        language: 'en',
        webContext: '',
        apiDetails: expect.any(String),
      }),
      expect.any(Object)
    );

    expect(result).toEqual({
      kind: 'search_results',
      message: 'Mocked synthesizer response for The Witcher.',
      data: {
        featured: { type: 'media', item: enrichResult.media[0] },
        games: enrichResult.games,
        media: [],
        books: [],
      },
    });
  });

  it('should handle OUT_OF_SCOPE intent', async () => {
    // Mock Router Response
    vi.mocked(routerPrompt).mockResolvedValue({
      output: {
        intent: 'OUT_OF_SCOPE',
        refusalReason: 'I cannot help with pasta.',
      },
    } as Awaited<ReturnType<typeof routerPrompt>>);

    const result = await orchestratorFlow({ query: 'How to cook pasta', language: 'en' });
    expect(result).toEqual({
      kind: 'refusal',
      message: 'I cannot help with pasta.',
    });
    expect(routerPrompt).toHaveBeenCalledTimes(1);
    expect(searchAll).not.toHaveBeenCalled();
  });

  it('should handle GENERAL_DISCOVERY intent', async () => {
    // 1. Router
    vi.mocked(routerPrompt).mockResolvedValue({
      output: {
        intent: 'GENERAL_DISCOVERY',
        category: 'ALL',
        extractedQuery: 'best sci-fi movies',
      },
    } as Awaited<ReturnType<typeof routerPrompt>>);

    // 2. Tavily Tool
    vi.mocked(searchTavilyTool).mockResolvedValue([
      { title: 'Dune Part 2', content: 'Epic movie', url: '...' },
    ] as Awaited<ReturnType<typeof searchTavilyTool>>);

    // 3. Extractor
    vi.mocked(extractorPrompt).mockResolvedValue({
      output: {
        titles: ['Dune Part 2'],
      },
    } as Awaited<ReturnType<typeof extractorPrompt>>);

    // 4. searchAll for enrichment
    const enrichmentData = {
      media: [{ title: 'Dune Part 2', id: 456, media_type: 'movie' }],
      games: [],
      books: [],
    };

    vi.mocked(searchAll).mockResolvedValue(
      enrichmentData as unknown as Awaited<ReturnType<typeof searchAll>>
    );

    // 5. Synthesizer
    vi.mocked(synthesizerPrompt).mockResolvedValue({
      text: 'Here are the best sci-fi movies: Dune Part 2...',
    } as any);

    const result = await orchestratorFlow({ query: 'Best sci-fi movies 2023', language: 'en' });

    expect(routerPrompt).toHaveBeenCalledWith(
      { query: 'Best sci-fi movies 2023', language: 'en' },
      expect.objectContaining({ model: expect.any(String) })
    );
    expect(searchTavilyTool).toHaveBeenCalledWith({
      query: 'best sci-fi movies',
      maxResults: 5,
      language: 'en',
    });
    expect(extractorPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ model: expect.any(String) })
    );
    expect(searchAll).toHaveBeenCalledWith({ query: 'Dune Part 2', language: 'en' });
    expect(synthesizerPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ model: expect.any(String) })
    );

    expect(result).toEqual({
      kind: 'discovery',
      message: 'Here are the best sci-fi movies: Dune Part 2...',
      data: {
        featured: { type: 'media', item: enrichmentData.media[0] },
        media: [],
        games: [],
        books: [],
      },
    });
  });

  it('should use searchMedia for GENERAL_DISCOVERY when category is MOVIE_TV', async () => {
    vi.mocked(routerPrompt).mockResolvedValue({
      output: {
        intent: 'GENERAL_DISCOVERY',
        category: 'MOVIE_TV',
        extractedQuery: 'horror movies',
      },
    } as Awaited<ReturnType<typeof routerPrompt>>);

    vi.mocked(searchTavilyTool).mockResolvedValue([
      { title: 'Smile 2', content: '...', url: '...', score: 0.95 },
    ]);
    vi.mocked(extractorPrompt).mockResolvedValue({ output: { titles: ['Smile 2'] } } as any);

    // Mock searchMedia specifically
    const mediaResult = [{ title: 'Smile 2', id: 666, media_type: 'movie' }];
    vi.mocked(searchMedia).mockResolvedValue({
      results: mediaResult,
      page: 1,
      hasMore: false,
      total: 1,
    } as any);

    vi.mocked(synthesizerPrompt).mockResolvedValue({ text: 'Smile 2 is a scary movie.' } as any);

    const result = await orchestratorFlow({ query: 'Best horror movies', language: 'en' });

    expect(searchMedia).toHaveBeenCalledWith({ query: 'Smile 2', language: 'en', page: 1 });
    expect(searchGames).not.toHaveBeenCalled();
    expect(searchBooks).not.toHaveBeenCalled();
    expect(searchAll).not.toHaveBeenCalled();

    expect(result).toEqual({
      kind: 'discovery',
      message: 'Smile 2 is a scary movie.',
      data: {
        featured: { type: 'media', item: mediaResult[0] },
        media: [],
        books: [],
        games: [],
      },
    });
  });

  it('should use searchGames for GENERAL_DISCOVERY when category is GAME', async () => {
    vi.mocked(routerPrompt).mockResolvedValue({
      output: {
        intent: 'GENERAL_DISCOVERY',
        category: 'GAME',
        extractedQuery: 'RPG games',
      },
    } as Awaited<ReturnType<typeof routerPrompt>>);

    vi.mocked(searchTavilyTool).mockResolvedValue([
      { title: "Baldur's Gate 3", content: '...', url: '...', score: 0.99 },
    ]);
    vi.mocked(extractorPrompt).mockResolvedValue({
      output: { titles: ["Baldur's Gate 3"] },
    } as any);

    const gameResult = [{ name: "Baldur's Gate 3", id: 999 }];
    vi.mocked(searchGames).mockResolvedValue({
      results: gameResult,
      page: 1,
      hasMore: false,
    } as any);

    vi.mocked(synthesizerPrompt).mockResolvedValue({ text: 'BG3 is great.' } as any);

    const result = await orchestratorFlow({ query: 'Best RPGs', language: 'en' });

    expect(searchGames).toHaveBeenCalledWith({ query: "Baldur's Gate 3", language: 'en', page: 1 });
    expect(searchMedia).not.toHaveBeenCalled();
    expect(searchBooks).not.toHaveBeenCalled();

    expect(result).toEqual({
      kind: 'discovery',
      message: 'BG3 is great.',
      data: {
        featured: { type: 'game', item: gameResult[0] },
        media: [],
        books: [],
        games: [],
      },
    });
  });

  it('should use searchBooks for GENERAL_DISCOVERY when category is BOOK', async () => {
    vi.mocked(routerPrompt).mockResolvedValue({
      output: {
        intent: 'GENERAL_DISCOVERY',
        category: 'BOOK',
        extractedQuery: 'horror novels',
      },
    } as Awaited<ReturnType<typeof routerPrompt>>);

    vi.mocked(searchTavilyTool).mockResolvedValue([
      { title: 'The Shining', content: '...', url: '...', score: 0.97 },
    ]);
    vi.mocked(extractorPrompt).mockResolvedValue({
      output: { titles: ['The Shining'] },
    } as any);

    const bookResult = [{ title: 'The Shining', id: 'abc123' }];
    vi.mocked(searchBooks).mockResolvedValue({
      results: bookResult,
      page: 1,
      hasMore: false,
      total: 1,
    } as any);

    vi.mocked(synthesizerPrompt).mockResolvedValue({
      text: 'The Shining is a classic horror novel.',
    } as any);

    const result = await orchestratorFlow({ query: 'Best horror books', language: 'en' });

    expect(searchBooks).toHaveBeenCalledWith({ query: 'The Shining', language: 'en', page: 1 });
    expect(searchMedia).not.toHaveBeenCalled();
    expect(searchGames).not.toHaveBeenCalled();

    expect(result).toEqual({
      kind: 'discovery',
      message: 'The Shining is a classic horror novel.',
      data: {
        featured: { type: 'book', item: bookResult[0] },
        media: [],
        books: [],
        games: [],
      },
    });
  });

  it('should deduplicate results by id in Path B (GENERAL_DISCOVERY)', async () => {
    vi.mocked(routerPrompt).mockResolvedValue({
      output: {
        intent: 'GENERAL_DISCOVERY',
        category: 'ALL',
        extractedQuery: 'batman',
      },
    } as Awaited<ReturnType<typeof routerPrompt>>);

    vi.mocked(searchTavilyTool).mockResolvedValue([
      { title: 'Batman', content: 'batman context', url: '...' },
    ] as Awaited<ReturnType<typeof searchTavilyTool>>);

    vi.mocked(extractorPrompt).mockResolvedValue({
      output: { titles: ['Batman', 'The Batman', 'Batman Begins'] },
    } as Awaited<ReturnType<typeof extractorPrompt>>);

    const mediaA = { title: 'Batman', id: 1, media_type: 'movie' as const };
    const mediaB = { title: 'The Batman', id: 2, media_type: 'movie' as const };
    const mediaC = { title: 'Batman Begins', id: 3, media_type: 'movie' as const };
    const gameA = { name: 'Batman: Arkham Knight', id: 100 };
    const gameB = { name: 'Batman LCD', id: 101 };

    vi.mocked(searchAll)
      .mockResolvedValueOnce({ media: [mediaA, mediaB], games: [gameA, gameB], books: [] } as any)
      .mockResolvedValueOnce({ media: [mediaB], games: [gameA], books: [] } as any) // duplicates
      .mockResolvedValueOnce({ media: [mediaC], games: [], books: [] } as any);

    vi.mocked(synthesizerPrompt).mockResolvedValue({ text: 'Batman results.' } as any);

    const result = await orchestratorFlow({ query: 'batman', language: 'en' });

    expect(result.kind).toBe('discovery');
    if (result.kind === 'discovery') {
      const mediaIds = result.data.media.map((m) => m.id);
      const gameIds = result.data.games.map((g) => g.id);

      // No duplicate ids
      expect(new Set(mediaIds).size).toBe(mediaIds.length);
      expect(new Set(gameIds).size).toBe(gameIds.length);

      // 'Batman' (id:1) is promoted to featured — 2 unique media items remain
      expect(result.data.featured).toBeDefined();
      expect((result.data.featured?.item as any).title).toBe('Batman');
      expect(result.data.media).toHaveLength(2);
      // 2 unique games after dedup
      expect(result.data.games).toHaveLength(2);
    }
  });

  it('should return an error object when routerPrompt fails (resolves to null)', async () => {
    vi.mocked(routerPrompt).mockResolvedValue({ output: null } as any);

    const result = await orchestratorFlow({ query: 'test router failure', language: 'en' });

    expect(result).toEqual({
      kind: 'error',
      error: expect.any(String),
      details: expect.any(String),
    });
  });

  it('should return search_results with fallback message when synthesizerPrompt throws an error', async () => {
    vi.mocked(routerPrompt).mockResolvedValue({
      output: {
        intent: 'SPECIFIC_ENTITY',
        category: 'MOVIE_TV',
        extractedQuery: 'Inception',
      },
    } as Awaited<ReturnType<typeof routerPrompt>>);

    const enrichResult = {
      media: [{ title: 'Inception', id: 1, media_type: 'movie' as const }],
      books: [],
      games: [],
    };
    vi.mocked(searchAll).mockResolvedValue(enrichResult as any);

    vi.mocked(synthesizerPrompt).mockRejectedValue(new Error('Synthesizer failed'));

    const result = await orchestratorFlow({ query: 'Movie Inception', language: 'en' });

    expect(result).toEqual({
      kind: 'search_results',
      message: expect.any(String),
      data: {
        featured: { type: 'media', item: { title: 'Inception', id: 1, media_type: 'movie' } },
        media: [],
        books: [],
        games: [],
      },
    });
  });
});
