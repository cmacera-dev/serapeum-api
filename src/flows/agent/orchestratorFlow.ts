import { inspect } from 'util';
import { ai, z, activeModel } from '../../lib/ai.js';
import { trace } from '@opentelemetry/api';
import { getContext } from '@genkit-ai/core';
import { getTranslations } from '../../lib/translations.js';
import { AgentResponseSchema, SearchAllOutputSchema } from '@serapeum/shared-schemas';
import { generateCacheKey, getCachedResponse, cacheAsync } from '../../lib/queryCache.js';
import { searchAll } from '../catalog/searchAll.js';
import { searchMedia } from '../catalog/searchMedia.js';
import { searchGames } from '../catalog/searchGames.js';
import { searchBooks } from '../catalog/searchBooks.js';
import { getMovieDetail } from '../catalog/getMovieDetail.js';
import { getTvDetail } from '../catalog/getTvDetail.js';
import { searchTavilyTool } from '../../tools/search-tavily-tool.js';
import { findBestMatch } from './findBestMatch.js';
import { routerPrompt } from '../../prompts/routerPrompt.js';
import { extractorPrompt } from '../../prompts/extractorPrompt.js';
import { synthesizerPrompt } from '../../prompts/synthesizerPrompt.js';

/**
 * Helper to execute the appropriate category search and normalize the output to SearchAllOutputSchema
 */
async function executeCategorySearch(
  category: 'MOVIE_TV' | 'GAME' | 'BOOK' | 'ALL',
  input: { query: string; language: string }
): Promise<z.infer<typeof SearchAllOutputSchema>> {
  switch (category) {
    case 'MOVIE_TV': {
      const res = await searchMedia({ ...input, page: 1 });
      return { media: res.results, books: [], games: [] };
    }
    case 'GAME': {
      const res = await searchGames({ ...input, page: 1 });
      return { media: [], books: [], games: res.results };
    }
    case 'BOOK': {
      const res = await searchBooks({ ...input, page: 1 });
      return { media: [], books: res.results, games: [] };
    }
    case 'ALL': {
      const res = await searchAll(input);
      return { media: res.media, books: res.books, games: res.games, errors: res.errors };
    }
    default: {
      const _exhaustiveCheck: never = category;
      throw new Error(`Unhandled category: ${_exhaustiveCheck}`);
    }
  }
}

function dedupeById<T extends { id: unknown }>(items: T[]): T[] {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

/**
 * Removes the featured item from its source array in the results object.
 * IDs are only unique within a source, so only the matching type is filtered.
 */
function removeFeaturedFromResults(
  results: z.infer<typeof SearchAllOutputSchema>,
  featuredMatch: ReturnType<typeof findBestMatch>
): void {
  if (!featuredMatch) return;
  const featuredId = (featuredMatch.item as { id?: unknown }).id;
  if (featuredId === undefined) return;
  if (featuredMatch.type === 'media' && results.media)
    results.media = results.media.filter((item) => item.id !== featuredId);
  else if (featuredMatch.type === 'game' && results.games)
    results.games = results.games.filter((item) => item.id !== featuredId);
  else if (featuredMatch.type === 'book' && results.books)
    results.books = results.books.filter((item) => item.id !== featuredId);
}

/**
 * Re-orders secondary results so the highest-quality items appear right after the featured.
 * Sort keys mirror the field the Flutter UI actually displays for each source — otherwise
 * the visible order would silently disagree with the underlying numeric ordering.
 *
 * - Media: voteAverage (TMDB), shown by the UI.
 * - Games: rating (IGDB community), with aggregated_rating (critic) as fallback — same
 *   priority the UI uses.
 * - Books: not sorted. averageRating is sparse in Google Books and the API's native
 *   relevance order is a stronger signal for that source.
 */
function sortByRating(results: z.infer<typeof SearchAllOutputSchema>): void {
  if (results.media) {
    results.media.sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0));
  }
  if (results.games) {
    const score = (g: { aggregated_rating?: number; rating?: number }): number =>
      g.rating ?? g.aggregated_rating ?? 0;
    results.games.sort((a, b) => score(b) - score(a));
  }
}

/**
 * Runs a catalog search across ALL categories, picks the best match as featured,
 * and removes it from its source array.
 * Shared by Path A (SPECIFIC_ENTITY) and Path D (FACTUAL_QUERY).
 *
 * @param preferredCategory - Used only to boost the matching category in findBestMatch;
 *   the underlying search always queries ALL categories.
 */
async function executeSearchWithFeatured(
  extractedQuery: string,
  preferredCategory: 'MOVIE_TV' | 'GAME' | 'BOOK' | 'ALL',
  language: string
): Promise<{
  executionResult: z.infer<typeof SearchAllOutputSchema>;
  featuredMatch: ReturnType<typeof findBestMatch>;
}> {
  const executionResult = await executeCategorySearch('ALL', { query: extractedQuery, language });
  const featuredMatch = findBestMatch(extractedQuery, preferredCategory, executionResult);

  if (featuredMatch) {
    executionResult.featured = featuredMatch;
    removeFeaturedFromResults(executionResult, featuredMatch);
  }
  sortByRating(executionResult);

  return { executionResult, featuredMatch };
}

// Flow
export const orchestratorFlow = ai.defineFlow(
  {
    name: 'orchestratorFlow',
    inputSchema: z.object({
      query: z.string(),
      language: z.enum(['en', 'es', 'fr', 'de', 'zh', 'ja']).optional().default('en'),
    }),
    outputSchema: AgentResponseSchema,
  },
  async (inputParam) => {
    const query = inputParam.query;
    const language = inputParam.language;

    // Cache lookup — short-circuits the full pipeline on a hit
    const cacheKey = generateCacheKey(query, language);
    const cached = await getCachedResponse(cacheKey);
    if (cached) return cached;

    // Attach userId from JWT as standard OTEL attribute — Langfuse maps 'user.id' to its User field
    // Capture traceId for feedback attribution (undefined when OTEL not active)
    let traceId: string | undefined;
    try {
      const span = trace.getActiveSpan();
      const userId = getContext()?.['sub'];
      if (userId) span?.setAttribute('user.id', String(userId));
      traceId = span?.spanContext().traceId;
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('Async context is not initialized'))) {
        console.warn('[orchestratorFlow] Failed to set user.id span attribute:', err);
      }
    }

    // 1. Router
    const { output: route } = await routerPrompt({ query, language }, { model: activeModel });

    if (!route) {
      console.error('[orchestratorFlow] Router failed to generate response');
      const t = getTranslations(language);
      return {
        kind: 'error' as const,
        error: 'Router failure',
        details: t['router_failure'],
        traceId,
      };
    }

    // Path C: Guardrail
    if (route.intent === 'OUT_OF_SCOPE') {
      const t = getTranslations(language);
      return cacheAsync(cacheKey, {
        kind: 'refusal' as const,
        message: route.refusalReason || t['generic_refusal'],
        traceId,
      });
    }

    // Path A: Specific Entity
    if (route.intent === 'SPECIFIC_ENTITY') {
      try {
        const { executionResult } = await executeSearchWithFeatured(
          route.extractedQuery,
          route.category,
          language
        );

        const t = getTranslations(language);
        let generatedText = t['specific_fallback'];
        try {
          const synthesis = await synthesizerPrompt(
            {
              originalQuery: route.extractedQuery,
              webContext: '',
              apiDetails: JSON.stringify(executionResult),
              language,
            },
            { model: activeModel }
          );
          if (synthesis.text && synthesis.text.trim()) {
            generatedText = synthesis.text;
          }
        } catch (error) {
          console.error(
            `[orchestratorFlow] Synthesizer failed for specific entity "${route.extractedQuery}":`,
            inspect(error, { depth: null, colors: true })
          );
        }

        return cacheAsync(cacheKey, {
          kind: 'search_results' as const,
          message: generatedText,
          data: executionResult,
          traceId,
        });
      } catch (error) {
        console.error(
          `[orchestratorFlow] Specific Entity Search failed for query "${route.extractedQuery}":`,
          inspect(error, { depth: null, colors: true })
        );
        const t = getTranslations(language);
        return {
          kind: 'error' as const,
          error: t['specific_error'],
          details: error instanceof Error ? error.message : String(error),
          traceId,
        };
      }
    }

    // Path D: Factual Query — same as Path A but fetches detail data for precise factual answers
    if (route.intent === 'FACTUAL_QUERY') {
      try {
        const { executionResult, featuredMatch } = await executeSearchWithFeatured(
          route.extractedQuery,
          route.category,
          language
        );

        // Fetch detailed data for media (movies/TV) — provides seasons, revenue, budget, etc.
        // Games and books already include enough factual data in the search result.
        // Guard on media_type explicitly to avoid calling detail endpoints for 'person' results.
        const languageToRegion: Record<string, string> = {
          en: 'US',
          es: 'ES',
          fr: 'FR',
          de: 'DE',
          zh: 'CN',
          ja: 'JP',
        };
        const region = languageToRegion[language] ?? 'US';

        let detail: unknown = null;
        if (featuredMatch?.type === 'media') {
          const item = featuredMatch.item as { id?: unknown; media_type?: unknown };
          try {
            if (typeof item.id === 'number' && item.media_type === 'movie') {
              detail = await getMovieDetail({ id: item.id, language, region });
            } else if (typeof item.id === 'number' && item.media_type === 'tv') {
              detail = await getTvDetail({ id: item.id, language, region });
            }
          } catch (err) {
            console.warn(
              '[orchestratorFlow] Detail fetch failed for factual query, continuing without it:',
              err
            );
          }
        }

        const t = getTranslations(language);
        let generatedText = t['specific_fallback'];
        try {
          const synthesis = await synthesizerPrompt(
            {
              originalQuery: query, // original question (not just the clean title)
              webContext: '',
              apiDetails: JSON.stringify({ ...executionResult, _queryType: 'factual', detail }),
              language,
            },
            { model: activeModel }
          );
          if (synthesis.text && synthesis.text.trim()) {
            generatedText = synthesis.text;
          }
        } catch (error) {
          console.error(
            `[orchestratorFlow] Synthesizer failed for factual query "${query}":`,
            inspect(error, { depth: null, colors: true })
          );
        }

        return cacheAsync(cacheKey, {
          kind: 'search_results' as const,
          message: generatedText,
          data: executionResult,
          traceId,
        });
      } catch (error) {
        console.error(
          `[orchestratorFlow] Factual Query path failed for "${route.extractedQuery}":`,
          inspect(error, { depth: null, colors: true })
        );
        const t = getTranslations(language);
        return {
          kind: 'error' as const,
          error: t['specific_error'],
          details: error instanceof Error ? error.message : String(error),
          traceId,
        };
      }
    }

    // Path B: General Discovery
    if (route.intent === 'GENERAL_DISCOVERY') {
      // 1. Search Tavily for context
      let tavilyContext = '';
      try {
        const tavilyResults = await searchTavilyTool({
          query: route.extractedQuery,
          language,
          maxResults: 5,
        });
        tavilyContext = tavilyResults.map((r) => r.content).join('\n');
      } catch (error) {
        console.error(
          `[orchestratorFlow] Tavily search failed for query "${route.extractedQuery}":`,
          inspect(error, { depth: null, colors: true })
        );
        // Continue with the empty context the declaration already provides, rather than
        // crashing: discovery still works without web results, just less well.
      }

      // 2. Extract Titles
      let extraction;
      try {
        const extractionResult = await extractorPrompt(
          { query: route.extractedQuery, context: tavilyContext },
          { model: activeModel }
        );
        extraction = extractionResult.output;
      } catch (error) {
        console.error(
          `[orchestratorFlow] Extractor failed for context length ${tavilyContext.length}:`,
          inspect(error, { depth: null, colors: true })
        );
        const t = getTranslations(language);
        return {
          kind: 'error' as const,
          error: t['failedProcessSearchResults'],
          details: error instanceof Error ? error.message : String(error),
          traceId,
        };
      }

      if (!extraction) {
        console.error('[orchestratorFlow] Extractor returned null output');
        const t = getTranslations(language);
        return {
          kind: 'error' as const,
          error: t['failedExtractSearchResults'],
          details: 'Title extraction returned null.',
          traceId,
        };
      }

      // 3. Search DBs for these titles (Enrichment)
      // We'll search for each title in parallel using the appropriate flow based on category
      const enrichmentPromises = extraction.titles.map(async (title) => {
        const input = { query: title, language };

        return await executeCategorySearch(
          route.category as 'MOVIE_TV' | 'GAME' | 'BOOK' | 'ALL',
          input
        );
      });

      const enrichmentResultsRaw = await Promise.allSettled(enrichmentPromises);

      // Aggregate results
      const enrichmentResults: z.infer<typeof SearchAllOutputSchema> = {
        media: [],
        books: [],
        games: [],
        errors: [],
      };

      for (const result of enrichmentResultsRaw) {
        if (result.status === 'fulfilled') {
          // result.value will always have { media, books, games } structure now
          if (result.value.media) enrichmentResults.media.push(...result.value.media);
          if (result.value.books) enrichmentResults.books.push(...result.value.books);
          if (result.value.games) enrichmentResults.games.push(...result.value.games);
          if (result.value.errors) enrichmentResults.errors!.push(...result.value.errors);
        } else {
          console.error(
            '[orchestratorFlow] Enrichment promise rejected:',
            inspect(result.reason, { depth: null, colors: true })
          );
        }
      }

      enrichmentResults.media = dedupeById(enrichmentResults.media);
      enrichmentResults.games = dedupeById(enrichmentResults.games);
      enrichmentResults.books = dedupeById(enrichmentResults.books);

      if (enrichmentResults.errors && enrichmentResults.errors.length === 0) {
        delete enrichmentResults.errors;
      }

      // Select featured item using the primary extracted title (first = most relevant)
      if (extraction.titles.length > 0) {
        const featuredMatch = findBestMatch(
          extraction.titles[0]!,
          route.category as 'MOVIE_TV' | 'GAME' | 'BOOK' | 'ALL',
          enrichmentResults
        );
        if (featuredMatch) {
          enrichmentResults.featured = featuredMatch;
          removeFeaturedFromResults(enrichmentResults, featuredMatch);
        }
      }
      sortByRating(enrichmentResults);

      // 4. Synthesize Answer
      try {
        const synthesis = await synthesizerPrompt(
          {
            originalQuery: query,
            webContext: tavilyContext,
            apiDetails: JSON.stringify(enrichmentResults),
            language,
          },
          { model: activeModel }
        );

        const t = getTranslations(language);
        let finalMessage =
          synthesis.text && synthesis.text.trim() ? synthesis.text : t.synthesis_failure;

        // Add a status message about partial failures if any
        if (enrichmentResults.errors && enrichmentResults.errors.length > 0) {
          const failedTitles = enrichmentResults.errors.map(
            (e) => e.message.split('"')[1] || 'Unknown'
          );
          const uniqueFailures = [...new Set(failedTitles)].filter((t) => t !== 'Unknown');

          if (uniqueFailures.length > 0) {
            finalMessage += `\n\n(${t.failedProcessSearchResults}: ${uniqueFailures.join(', ')})`;
          }
        }

        return cacheAsync(cacheKey, {
          kind: 'discovery' as const,
          message: finalMessage,
          data: enrichmentResults,
          traceId,
        });
      } catch (error) {
        console.error(
          `[orchestratorFlow] Synthesizer failed for query "${query}":`,
          inspect(error, { depth: null, colors: true })
        );
        // Fallback: return data with a generic message
        const t = getTranslations(language);
        return cacheAsync(cacheKey, {
          kind: 'discovery' as const,
          message: t['synthesis_failure'],
          data: enrichmentResults,
          traceId,
        });
      }
    }

    const t = getTranslations(language);
    return cacheAsync(cacheKey, {
      kind: 'refusal' as const,
      message: t['unrecognized_intent'],
      traceId,
    });
  }
);
