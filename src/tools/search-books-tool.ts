import { ai, z } from '../lib/ai.js';
import { CATALOG_PAGE_SIZE, MAX_RESULTS_PER_SOURCE } from '../lib/constants.js';
import axios from 'axios';
import { withRetry } from '../lib/retry.js';

const GOOGLE_BOOKS_TIMEOUT = 5000;
import type {
  GoogleBooksSearchResponse,
  GoogleBooksVolume,
  BookSearchResult,
  IndustryIdentifier,
} from '../lib/google-books-types.js';
import { BookSearchResultSchema } from '../schemas/book-schemas.js';
import type { PaginatedBookResult } from '../schemas/book-schemas.js';

/**
 * Helper function to extract ISBN from industry identifiers
 * Prefers ISBN-13 over ISBN-10
 */
function extractISBN(identifiers?: IndustryIdentifier[]): string | undefined {
  if (!identifiers || identifiers.length === 0) return undefined;

  // Prefer ISBN_13
  const isbn13 = identifiers.find((id) => id.type === 'ISBN_13');
  if (isbn13) return isbn13.identifier;

  // Fallback to ISBN_10
  const isbn10 = identifiers.find((id) => id.type === 'ISBN_10');
  return isbn10?.identifier;
}

function mapBookResult(item: GoogleBooksVolume): BookSearchResult {
  return {
    id: item.id,
    title: item.volumeInfo.title,
    authors: item.volumeInfo.authors,
    publisher: item.volumeInfo.publisher,
    publishedDate: item.volumeInfo.publishedDate,
    description: item.volumeInfo.description,
    isbn: extractISBN(item.volumeInfo.industryIdentifiers),
    pageCount: item.volumeInfo.pageCount,
    categories: item.volumeInfo.categories,
    imageLinks: item.volumeInfo.imageLinks
      ? {
          thumbnail: item.volumeInfo.imageLinks.thumbnail,
          smallThumbnail: item.volumeInfo.imageLinks.smallThumbnail,
        }
      : undefined,
    language: item.volumeInfo.language,
    previewLink: item.volumeInfo.previewLink,
    averageRating: item.volumeInfo.averageRating,
    printType: item.volumeInfo.printType,
    maturityRating: item.volumeInfo.maturityRating,
  };
}

/**
 * Core fetch function with pagination support. Used by both the Genkit tool
 * (page 1, orchestrator) and the catalog flow (client-supplied page).
 */
export async function fetchBookResults(input: {
  query: string;
  language?: string;
  page: number;
}): Promise<PaginatedBookResult> {
  const apiKey = process.env['GOOGLE_BOOKS_API_KEY'];

  if (!apiKey) {
    throw new Error('GOOGLE_BOOKS_API_KEY environment variable is not configured');
  }

  const startIndex = (input.page - 1) * CATALOG_PAGE_SIZE;
  const langCandidate = (input.language ?? '').trim().split('-')[0]?.toLowerCase() ?? '';
  const normalizedLanguage = /^[a-z]{2,3}$/.test(langCandidate) ? langCandidate : 'en';

  try {
    const response = await withRetry(() =>
      axios.get<GoogleBooksSearchResponse>('https://www.googleapis.com/books/v1/volumes', {
        params: {
          q: `intitle:${input.query}`,
          key: apiKey,
          maxResults: CATALOG_PAGE_SIZE,
          startIndex,
          printType: 'books', // Exclude magazines
          orderBy: 'relevance',
          langRestrict: normalizedLanguage,
        },
        headers: {
          Accept: 'application/json',
        },
        timeout: GOOGLE_BOOKS_TIMEOUT,
      })
    );

    const totalItems = response.data.totalItems ?? 0;

    const results: BookSearchResult[] = (response.data.items ?? [])
      .map(mapBookResult)
      .filter((r) => r.imageLinks?.thumbnail && r.description && r.authors?.length);

    return {
      results,
      page: input.page,
      // Conservative: based on requested page size so quality-gate filtering
      // doesn't cause premature hasMore: false on a sparse-but-non-final page
      hasMore: startIndex + CATALOG_PAGE_SIZE < totalItems,
      total: totalItems,
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        const status = error.response.status;
        if (status === 401 || status === 403) {
          throw new Error('Google Books API authentication failed. Please check your API key.', {
            cause: error,
          });
        } else if (status === 429) {
          throw new Error('Google Books API rate limit exceeded. Please try again later.', {
            cause: error,
          });
        } else {
          throw new Error(`Google Books API error (${status}): ${error.response.statusText}`, {
            cause: error,
          });
        }
      } else if (error.request) {
        throw new Error(
          'Network error: Unable to reach Google Books API. Please check your internet connection.',
          { cause: error }
        );
      }
    }

    throw error;
  }
}

/**
 * Genkit Tool: Search for books using Google Books API
 */
export const searchBooksTool = ai.defineTool(
  {
    name: 'searchBooksTool',
    description:
      'Search for books using the Google Books API. Returns detailed book information including title, authors, publisher, ISBN, description, and cover images.',
    inputSchema: z.object({
      query: z.string().min(1, 'Search query cannot be empty'),
      language: z
        .string()
        .regex(/^[a-z]{2}$/, 'Language must be a 2-letter ISO 639-1 code (lowercase)')
        .optional()
        .default('en'),
    }),
    outputSchema: z.array(BookSearchResultSchema),
  },
  async (input) => {
    const paginated = await fetchBookResults({ ...input, page: 1 });
    return paginated.results.slice(0, MAX_RESULTS_PER_SOURCE);
  }
);
