import { ai, z } from '../lib/ai.js';
import { CATALOG_PAGE_SIZE, MAX_RESULTS_PER_SOURCE } from '../lib/constants.js';
import axios from 'axios';
import { withRetry } from '../lib/retry.js';

const TMDB_TIMEOUT = 5000;
import type { TMDBSearchResponse, TMDBSearchResult, MediaSearchResult } from '../lib/tmdb-types.js';
import { TMDB_GENRE_MAP } from '../lib/tmdb-types.js';
import { MediaSearchResultSchema } from '../schemas/media-schemas.js';
import type { PaginatedMediaResult } from '../schemas/media-schemas.js';

/**
 * Quality gate for TMDB search results: keeps only movies/TV shows that have
 * at least one vote (excludes stubs), a poster, a non-blank overview, and a
 * non-blank title or name.
 */
function isHighQualityMediaResult(result: TMDBSearchResult): boolean {
  return (
    (result.media_type === 'movie' || result.media_type === 'tv') &&
    (result.vote_count ?? 0) > 0 &&
    Boolean(result.poster_path) &&
    Boolean(result.overview?.trim()) &&
    Boolean(result.title?.trim() || result.name?.trim())
  );
}

function mapMediaResult(result: TMDBSearchResult): MediaSearchResult {
  return {
    id: result.id,
    title: result.title,
    name: result.name,
    media_type: result.media_type as 'movie' | 'tv',
    release_date: result.release_date || result.first_air_date,
    poster_path: result.poster_path,
    overview: result.overview,
    vote_average: result.vote_average,
    popularity: result.popularity,
    backdrop_path: result.backdrop_path,
    genre_ids: result.genre_ids,
    genres: result.genre_ids
      ?.map((id) => TMDB_GENRE_MAP[id])
      .filter((g): g is string => Boolean(g)),
    original_language: result.original_language,
  };
}

/**
 * Core fetch function with pagination support. Used by both the Genkit tool
 * (page 1, orchestrator) and the catalog flow (client-supplied page).
 */
export async function fetchMediaResults(input: {
  query: string;
  language?: string;
  page: number;
}): Promise<PaginatedMediaResult> {
  const apiKey = process.env['TMDB_API_KEY'];

  if (!apiKey) {
    throw new Error('TMDB_API_KEY environment variable is not configured');
  }

  try {
    const response = await withRetry(() =>
      axios.get<TMDBSearchResponse>('https://api.themoviedb.org/3/search/multi', {
        params: {
          api_key: apiKey,
          query: input.query,
          language: input.language ?? 'en',
          include_adult: false,
          page: input.page,
        },
        headers: {
          Accept: 'application/json',
        },
        timeout: TMDB_TIMEOUT,
      })
    );

    const results: MediaSearchResult[] = response.data.results
      .filter(isHighQualityMediaResult)
      .map(mapMediaResult)
      .slice(0, CATALOG_PAGE_SIZE);

    return {
      results,
      page: input.page,
      // hasMore is derived from raw TMDB metadata, not from filtered result count.
      // A catalog page may contain fewer than CATALOG_PAGE_SIZE items when many
      // results fail the quality gate, but hasMore will still be true if TMDB
      // has more pages — this is intentional (conservative, avoids false negatives).
      hasMore: input.page < response.data.total_pages,
      total: response.data.total_results,
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        const status = error.response.status;
        if (status === 401) {
          throw new Error('TMDB API authentication failed. Please check your API key.', {
            cause: error,
          });
        } else if (status === 429) {
          throw new Error('TMDB API rate limit exceeded. Please try again later.', {
            cause: error,
          });
        } else {
          throw new Error(`TMDB API error (${status}): ${error.response.statusText}`, {
            cause: error,
          });
        }
      } else if (error.request) {
        throw new Error(
          'Network error: Unable to reach TMDB API. Please check your internet connection.',
          { cause: error }
        );
      }
    }

    throw error;
  }
}

export const searchMediaTool = ai.defineTool(
  {
    name: 'searchMediaTool',
    description:
      'Search for movies and TV shows using The Movie Database (TMDB) API. Returns clean, structured data for UI consumption.',
    inputSchema: z.object({
      query: z.string().min(1, 'Search query cannot be empty'),
      language: z.string().optional().default('en'),
    }),
    outputSchema: z.array(MediaSearchResultSchema),
  },
  async (input) => {
    const paginated = await fetchMediaResults({ ...input, page: 1 });
    return paginated.results.slice(0, MAX_RESULTS_PER_SOURCE);
  }
);
