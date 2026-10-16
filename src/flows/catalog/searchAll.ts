import { ai, z } from '../../lib/ai.js';
import { searchMediaTool } from '../../tools/search-media-tool.js';
import { searchBooksTool } from '../../tools/search-books-tool.js';
import { searchGamesTool } from '../../tools/search-games-tool.js';
import { SearchAllOutputSchema, SearchErrorSchema } from '@serapeum/shared-schemas';
import { summarizeError } from '../../lib/errorSummary.js';

export const searchAll = ai.defineFlow(
  {
    name: 'searchAll',
    inputSchema: z.object({
      query: z.string().min(1, 'Search query cannot be empty'),
      language: z.string().optional().default('en'),
    }),
    outputSchema: SearchAllOutputSchema,
  },
  async (input) => {
    // Execute all searches in parallel using Promise.allSettled
    const results = await Promise.allSettled([
      searchMediaTool(input),
      searchBooksTool(input),
      searchGamesTool(input),
    ]);

    // results[0] -> movies (Promise<MediaSearchResult[]>)
    // results[1] -> books (Promise<BookSearchResult[]>)
    // results[2] -> games (Promise<GameSearchResult[]>)

    const movieResult = results[0];
    const bookResult = results[1];
    const gameResult = results[2];

    const media = movieResult.status === 'fulfilled' ? movieResult.value : [];
    const books = bookResult.status === 'fulfilled' ? bookResult.value : [];
    const games = gameResult.status === 'fulfilled' ? gameResult.value : [];

    const errors: Array<z.infer<typeof SearchErrorSchema>> = [];

    if (movieResult.status === 'rejected') {
      console.error(`SearchMedia failed: ${summarizeError(movieResult.reason)}`);
      errors.push({
        source: 'media',
        message:
          movieResult.reason instanceof Error
            ? movieResult.reason.message
            : String(movieResult.reason),
      });
    }
    if (bookResult.status === 'rejected') {
      console.error(`SearchBooks failed: ${summarizeError(bookResult.reason)}`);
      errors.push({
        source: 'books',
        message:
          bookResult.reason instanceof Error
            ? bookResult.reason.message
            : String(bookResult.reason),
      });
    }
    if (gameResult.status === 'rejected') {
      console.error(`SearchGames failed: ${summarizeError(gameResult.reason)}`);
      errors.push({
        source: 'games',
        message:
          gameResult.reason instanceof Error
            ? gameResult.reason.message
            : String(gameResult.reason),
      });
    }

    return {
      media,
      books,
      games,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
);
