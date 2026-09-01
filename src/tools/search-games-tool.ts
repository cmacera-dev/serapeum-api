import { ai, z } from '../lib/ai.js';
import { CATALOG_PAGE_SIZE, MAX_RESULTS_PER_SOURCE } from '../lib/constants.js';
import { getAccessToken, clearTokenCache } from '../lib/igdb-auth.js';
import type { IGDBGame, GameSearchResult } from '../lib/igdb-types.js';
import { transformGame } from '../lib/igdb-types.js';
import { GameSearchResultSchema } from '../schemas/game-schemas.js';
import type { PaginatedGameResult } from '../schemas/game-schemas.js';
import { withRetry, HttpError } from '../lib/retry.js';

/**
 * Core fetch function with pagination support. Used by both the Genkit tool
 * (page 1, orchestrator) and the catalog flow (client-supplied page).
 *
 * Note: IGDB does not return a total result count, so `hasMore` is derived
 * from whether the raw (pre-filter) response was a full page.
 */
export async function fetchGameResults(input: {
  query: string;
  language?: string;
  page: number;
}): Promise<PaginatedGameResult> {
  const clientId = process.env['IGDB_CLIENT_ID'];

  if (!clientId) {
    throw new Error('IGDB_CLIENT_ID environment variable is not configured');
  }

  try {
    const accessToken = await getAccessToken();

    // Sanitize query to prevent Apicalypse injection.
    // Order: escape backslashes first so later replacements don't double-escape.
    const sanitizedQuery = input.query
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/[\r\n]/g, ' ');
    const offset = (input.page - 1) * CATALOG_PAGE_SIZE;

    const apicalypseQuery = `
      search "${sanitizedQuery}";
      fields name,game_type,summary,rating,aggregated_rating,first_release_date,cover.image_id,platforms.name,genres.name,involved_companies.company.name,involved_companies.developer,involved_companies.publisher,screenshots.image_id,videos.video_id,themes.name,game_modes.name,age_ratings.organization.name,age_ratings.rating_category.rating,similar_games.id,similar_games.name;
      where game_type = (0, 1, 2, 8, 9, 10) & version_parent = null;
      limit ${CATALOG_PAGE_SIZE + 1};
      offset ${offset};
    `.trim();

    const response = await withRetry(async () => {
      const r = await fetch('https://api.igdb.com/v4/games', {
        method: 'POST',
        headers: {
          'Client-ID': clientId,
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'text/plain',
        },
        body: apicalypseQuery,
      });
      if (r.status === 429 || r.status === 503) {
        throw new HttpError(r.status, `IGDB HTTP ${r.status}`);
      }
      return r;
    });

    if (!response.ok) {
      if (response.status === 401) {
        clearTokenCache();
        throw new Error('IGDB authentication failed. Access token may have expired.');
      }

      const errorText = await response.text();
      throw new Error(`IGDB API request failed: ${response.status} ${errorText}`);
    }

    // Fetch CATALOG_PAGE_SIZE + 1 sentinel rows so hasMore can be determined
    // without a separate count query. Trim to page size before transforming.
    const rawGames = (await response.json()) as IGDBGame[];
    const hasMore = rawGames.length > CATALOG_PAGE_SIZE;
    const pagedGames = rawGames.slice(0, CATALOG_PAGE_SIZE);

    const results: GameSearchResult[] = pagedGames
      .map(transformGame)
      .filter((r): r is GameSearchResult & { cover_url: string; summary: string } =>
        Boolean(r.cover_url && r.summary)
      );

    return { results, page: input.page, hasMore };
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.status === 429)
        throw new Error('IGDB API rate limit exceeded. Please try again later.', { cause: error });
      throw error;
    }
    if (error instanceof Error) {
      // Re-throw already-classified provider errors unchanged
      if (error.message.startsWith('IGDB')) throw error;
      throw new Error(`Failed to search games: ${error.message}`, { cause: error });
    }
    throw new Error('Failed to search games with unknown error', { cause: error });
  }
}

export const searchGamesTool = ai.defineTool(
  {
    name: 'searchGamesTool',
    description:
      'Search for video games using the IGDB (Internet Game Database) API. Returns detailed game information including title, platforms, genres, developers, and ratings.',
    inputSchema: z.object({
      query: z.string().min(1, 'Search query cannot be empty'),
      // Note: IGDB API does not support language filtering in search queries
      // This parameter is accepted for consistency across search tools but is not used
      language: z.string().optional().default('en'),
    }),
    outputSchema: z.array(GameSearchResultSchema),
  },
  async (input) => {
    const paginated = await fetchGameResults({ ...input, page: 1 });
    return paginated.results.slice(0, MAX_RESULTS_PER_SOURCE);
  }
);
