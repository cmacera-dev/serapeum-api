import { ai, z } from '../lib/ai.js';
import { tavily } from '@tavily/core';
import { withRetry } from '../lib/retry.js';
import type { TavilySearchResult } from '../lib/tavily-types.js';

/**
 * Genkit Tool: Web search using Tavily API
 * Provides high-quality, AI-optimized search results.
 */
export const TavilySearchResultSchema = z.object({
  title: z.string(),
  url: z.string().url(),
  content: z.string(),
  score: z.number(),
  published_date: z.string().optional(),
});

interface ErrorWithStatus {
  status?: number;
  response?: { status?: number };
  message?: string;
  code?: string;
}

export const searchTavilyTool = ai.defineTool(
  {
    name: 'searchTavilyTool',
    description:
      'Perform a comprehensive web search using the Tavily API. Use this tool to find up-to-date information, news, research data, or general web content that is not available in specialized tools.',
    inputSchema: z.object({
      query: z.string().min(1, 'Search query cannot be empty'),
      // Note: Tavily API does not support language filtering
      // This parameter is accepted for consistency across search tools but is not used
      language: z.string().optional(),
      searchDepth: z.enum(['basic', 'advanced']).optional(),
      maxResults: z.number().min(1).max(10).optional(),
    }),
    outputSchema: z.array(TavilySearchResultSchema),
  },
  async (input) => {
    const apiKey = process.env['TAVILY_API_KEY'];

    if (!apiKey) {
      throw new Error('TAVILY_API_KEY environment variable is not configured');
    }

    try {
      const tvly = tavily({ apiKey });
      const response = await withRetry(() =>
        tvly.search(input.query, {
          searchDepth: input.searchDepth,
          maxResults: input.maxResults,
          includeAnswer: false,
          includeImages: false,
          includeRawContent: false,
        })
      );

      // Map results to ensure they match our schema
      const results: TavilySearchResult[] = response.results.map((result) => ({
        title: result.title,
        url: result.url,
        content: result.content,
        score: result.score,
        published_date: result.publishedDate,
      }));

      return results;
    } catch (error: unknown) {
      // Handle common API errors
      const err = error as ErrorWithStatus;
      const status = err?.status || err?.response?.status;

      if (status === 401) {
        throw new Error('Tavily API authentication failed. Please check your API key.', {
          cause: error,
        });
      } else if (status === 429) {
        throw new Error('Tavily API rate limit exceeded. Please try again later.', {
          cause: error,
        });
      } else if (status === 503) {
        throw new Error('Tavily API service unavailable (503). Please try again later.', {
          cause: error,
        });
      } else if (err.message?.includes('network') || err.code === 'ECONNREFUSED') {
        throw new Error(
          'Network error: Unable to reach Tavily API. Please check your internet connection.',
          { cause: error }
        );
      }

      throw new Error(`Tavily API error: ${err?.message || 'Unknown error'}`, { cause: error });
    }
  }
);
