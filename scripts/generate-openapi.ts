/**
 * OpenAPI Spec Generator
 *
 * Generates docs/openapi.yaml from the Zod schemas defined in each Genkit flow.
 * Run with: npm run generate:openapi
 */

import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  extendZodWithOpenApi,
  OpenApiGeneratorV31,
  OpenAPIRegistry,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import * as yaml from 'yaml';
import {
  MediaSearchResultSchema,
  BookSearchResultSchema,
  GameSearchResultSchema,
  PaginatedMediaResultSchema,
  PaginatedBookResultSchema,
  PaginatedGameResultSchema,
  SearchErrorSchema as SearchErrorSchemaBase,
  CastMemberSchema,
  VideoSchema,
  WatchProviderSchema,
  WatchProviderRegionSchema,
  SeasonSummarySchema,
  MovieDetailSchema,
  TvDetailSchema,
} from '@serapeum/shared-schemas';
import { FEEDBACK_COMMENT_MAX_LENGTH } from '../src/lib/constants.js';

// Extend Zod with OpenAPI support (must be called before any .openapi() calls)
extendZodWithOpenApi(z);

// ---------------------------------------------------------------------------
// Schemas — imported from src/schemas/ (single source of truth)
// ---------------------------------------------------------------------------

const BookSchema = BookSearchResultSchema.openapi('Book');
const MediaSchema = MediaSearchResultSchema.openapi('Media');
const GameSchema = GameSearchResultSchema.openapi('Game');
const SearchErrorSchema = SearchErrorSchemaBase.openapi('SearchError');

const CastMemberOpenApi = CastMemberSchema.openapi('CastMember');
const VideoOpenApi = VideoSchema.openapi('Video');
const WatchProviderOpenApi = WatchProviderSchema.openapi('WatchProvider');
// Re-define with annotated sub-schemas so zod-to-openapi emits $ref instead
// of inlining WatchProvider's properties for each flatrate/rent/buy array.
const WatchProviderRegionOpenApi = WatchProviderRegionSchema.extend({
  flatrate: z.array(WatchProviderOpenApi).optional(),
  rent: z.array(WatchProviderOpenApi).optional(),
  buy: z.array(WatchProviderOpenApi).optional(),
}).openapi('WatchProviderRegion');
const WatchProvidersByRegionOpenApi = z.record(z.string(), WatchProviderRegionOpenApi);
const SeasonSummaryOpenApi = SeasonSummarySchema.openapi('SeasonSummary');
// Re-define with annotated sub-schemas so cast/trailers/watch_providers emit
// $ref to CastMember, Video, and WatchProviderRegion respectively.
const MovieDetailOpenApi = MovieDetailSchema.extend({
  cast: z.array(CastMemberOpenApi).max(10).optional(),
  trailers: z.array(VideoOpenApi).optional(),
  watch_providers: WatchProvidersByRegionOpenApi.optional(),
}).openapi('MovieDetail');
const TvDetailOpenApi = TvDetailSchema.extend({
  cast: z.array(CastMemberOpenApi).max(10).optional(),
  trailers: z.array(VideoOpenApi).optional(),
  watch_providers: WatchProvidersByRegionOpenApi.optional(),
}).openapi('TvDetail');

// SearchAllResponseSchema is intentionally kept local: it must reference the
// annotated schemas above (MediaSchema, BookSchema, etc.) so the generator
// emits $ref pointers rather than inlining the sub-schemas in the YAML.
const FeaturedItemSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('media'), item: MediaSchema }),
    z.object({ type: z.literal('book'), item: BookSchema }),
    z.object({ type: z.literal('game'), item: GameSchema }),
  ])
  .openapi('FeaturedItem');

const SearchAllResponseSchema = z
  .object({
    featured: FeaturedItemSchema.optional(),
    media: z.array(MediaSchema),
    books: z.array(BookSchema),
    games: z.array(GameSchema),
    errors: z.array(SearchErrorSchema).optional(),
  })
  .openapi('SearchAllResponse');

// ---------------------------------------------------------------------------
// Composite / response schemas
// ---------------------------------------------------------------------------

const PaginatedBooksResponseSchema = PaginatedBookResultSchema.extend({
  results: z.array(BookSchema),
}).openapi('PaginatedBooksResponse');

const PaginatedMediaResponseSchema = PaginatedMediaResultSchema.extend({
  results: z.array(MediaSchema),
}).openapi('PaginatedMediaResponse');

const PaginatedGamesResponseSchema = PaginatedGameResultSchema.extend({
  results: z.array(GameSchema),
}).openapi('PaginatedGamesResponse');

const ErrorResponseSchema = z
  .object({
    error: z.string(),
    details: z.string().optional(),
  })
  .openapi('ErrorResponse');

// Orchestrator response: discriminated union matching AgentResponseSchema.
// Rebuilt locally so SearchAllResponseSchema uses $ref pointers.
const AgentRefusalSchema = z
  .object({
    kind: z.literal('refusal'),
    message: z.string(),
    traceId: z
      .string()
      .optional()
      .openapi({ description: 'Langfuse trace ID for feedback attribution' }),
  })
  .openapi('AgentRefusal');

const AgentSearchResultsSchema = z
  .object({
    kind: z.literal('search_results'),
    message: z.string(),
    data: SearchAllResponseSchema,
    traceId: z
      .string()
      .optional()
      .openapi({ description: 'Langfuse trace ID for feedback attribution' }),
  })
  .openapi('AgentSearchResults');

const AgentDiscoverySchema = z
  .object({
    kind: z.literal('discovery'),
    message: z.string(),
    data: SearchAllResponseSchema,
    traceId: z
      .string()
      .optional()
      .openapi({ description: 'Langfuse trace ID for feedback attribution' }),
  })
  .openapi('AgentDiscovery');

const AgentErrorSchema = z
  .object({
    kind: z.literal('error'),
    error: z.string(),
    details: z.string().optional(),
    traceId: z
      .string()
      .optional()
      .openapi({ description: 'Langfuse trace ID for feedback attribution' }),
  })
  .openapi('AgentError');

const OrchestratorResponseSchema = z
  .discriminatedUnion('kind', [
    AgentRefusalSchema,
    AgentSearchResultsSchema,
    AgentDiscoverySchema,
    AgentErrorSchema,
  ])
  .openapi('OrchestratorResponse');

// ---------------------------------------------------------------------------
// Shared input schemas
// ---------------------------------------------------------------------------

const CatalogSearchInputSchema = z
  .object({
    query: z.string().min(1).openapi({ description: 'Search query string', example: 'Dune' }),
    language: z
      .string()
      .optional()
      .openapi({ description: 'BCP-47 language tag (e.g. en, es-ES)', example: 'en' }),
    page: z
      .number()
      .int()
      .positive()
      .optional()
      .openapi({ description: 'Page number for pagination (default: 1)', example: 1 }),
  })
  .openapi('CatalogSearchInput');

const OrchestratorInputSchema = z.string().min(1).openapi({
  description: 'Natural language query for the AI orchestrator',
  example: 'Best sci-fi movies of 2024',
});

const MediaDetailInputSchema = z
  .object({
    id: z
      .number()
      .int()
      .positive()
      .openapi({ description: 'TMDB movie or TV show ID', example: 550 }),
    language: z
      .string()
      .optional()
      .openapi({ description: 'BCP-47 language tag (e.g. en, es-ES)', example: 'en' }),
    region: z.string().optional().openapi({
      description:
        'ISO 3166-1 country code to filter watch providers (e.g. US, ES, MX). Defaults to US if not provided.',
      example: 'ES',
    }),
  })
  .openapi('MediaDetailInput');

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new OpenAPIRegistry();

registry.register('Book', BookSchema);
registry.register('Media', MediaSchema);
registry.register('Game', GameSchema);
registry.register('SearchError', SearchErrorSchema);
registry.register('FeaturedItem', FeaturedItemSchema);
registry.register('SearchAllResponse', SearchAllResponseSchema);
registry.register('PaginatedBooksResponse', PaginatedBooksResponseSchema);
registry.register('PaginatedMediaResponse', PaginatedMediaResponseSchema);
registry.register('PaginatedGamesResponse', PaginatedGamesResponseSchema);
registry.register('ErrorResponse', ErrorResponseSchema);
registry.register('AgentRefusal', AgentRefusalSchema);
registry.register('AgentSearchResults', AgentSearchResultsSchema);
registry.register('AgentDiscovery', AgentDiscoverySchema);
registry.register('AgentError', AgentErrorSchema);
registry.register('OrchestratorResponse', OrchestratorResponseSchema);
registry.register('CatalogSearchInput', CatalogSearchInputSchema);
registry.register('CastMember', CastMemberOpenApi);
registry.register('Video', VideoOpenApi);
registry.register('WatchProvider', WatchProviderOpenApi);
registry.register('WatchProviderRegion', WatchProviderRegionOpenApi);
registry.register('SeasonSummary', SeasonSummaryOpenApi);
registry.register('MovieDetail', MovieDetailOpenApi);
registry.register('TvDetail', TvDetailOpenApi);
registry.register('MediaDetailInput', MediaDetailInputSchema);

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

registry.registerPath({
  method: 'post',
  path: '/searchBooks',
  summary: 'Search for books',
  description: 'Searches the Google Books API and returns a list of matching books.',
  tags: ['Catalog'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: CatalogSearchInputSchema } },
    },
  },
  responses: {
    200: {
      description: 'Paginated list of matching books',
      content: { 'application/json': { schema: PaginatedBooksResponseSchema } },
    },
    400: {
      description: 'Invalid request body',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: 'Unauthorized — missing or invalid bearer token',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/searchMedia',
  summary: 'Search for movies and TV shows',
  description: 'Searches the TMDB API and returns a list of matching movies and TV shows.',
  tags: ['Catalog'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: CatalogSearchInputSchema } },
    },
  },
  responses: {
    200: {
      description: 'Paginated list of matching movies and TV shows',
      content: { 'application/json': { schema: PaginatedMediaResponseSchema } },
    },
    400: {
      description: 'Invalid request body',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: 'Unauthorized — missing or invalid bearer token',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/searchGames',
  summary: 'Search for video games',
  description: 'Searches the IGDB API and returns a list of matching video games.',
  tags: ['Catalog'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: CatalogSearchInputSchema } },
    },
  },
  responses: {
    200: {
      description: 'Paginated list of matching video games',
      content: { 'application/json': { schema: PaginatedGamesResponseSchema } },
    },
    400: {
      description: 'Invalid request body',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: 'Unauthorized — missing or invalid bearer token',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/searchAll',
  summary: 'Search across all media types',
  description:
    'Searches books, movies/TV shows, and games in parallel and returns aggregated results.',
  tags: ['Catalog'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: CatalogSearchInputSchema } },
    },
  },
  responses: {
    200: {
      description: 'Aggregated results from all media sources',
      content: { 'application/json': { schema: SearchAllResponseSchema } },
    },
    400: {
      description: 'Invalid request body',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: 'Unauthorized — missing or invalid bearer token',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/orchestratorFlow',
  summary: 'AI orchestrator',
  description:
    'Routes a natural language query through the AI orchestrator. Returns structured catalog data, a synthesized text+data response, or a plain text reply depending on the query intent.',
  tags: ['Agent'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: {
        'application/json': { schema: OrchestratorInputSchema },
      },
    },
  },
  responses: {
    200: {
      description: 'Orchestrator response (varies by query intent)',
      content: { 'application/json': { schema: OrchestratorResponseSchema } },
    },
    400: {
      description: 'Invalid request body',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: 'Unauthorized — missing or invalid bearer token',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/getMovieDetail',
  summary: 'Get movie details',
  description:
    'Returns full details for a movie: cast, trailers, watch providers, and extended metadata.',
  tags: ['Catalog'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: MediaDetailInputSchema } },
    },
  },
  responses: {
    200: {
      description: 'Full movie detail',
      content: { 'application/json': { schema: MovieDetailOpenApi } },
    },
    400: {
      description: 'Invalid request body',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: 'Unauthorized — missing or invalid bearer token',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Movie not found in TMDB',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    429: {
      description: 'Too many requests — TMDB rate limit exceeded',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/getTvDetail',
  summary: 'Get TV show details',
  description:
    'Returns full details for a TV show: cast, trailers, seasons, watch providers, and extended metadata.',
  tags: ['Catalog'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: MediaDetailInputSchema } },
    },
  },
  responses: {
    200: {
      description: 'Full TV show detail',
      content: { 'application/json': { schema: TvDetailOpenApi } },
    },
    400: {
      description: 'Invalid request body',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: 'Unauthorized — missing or invalid bearer token',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'TV show not found in TMDB',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    429: {
      description: 'Too many requests — TMDB rate limit exceeded',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description: 'Internal server error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const FeedbackInputSchema = z
  .object({
    traceId: z
      .string()
      .min(1)
      .openapi({ description: 'Trace ID from an orchestratorFlow response', example: 'abc123ef' }),
    score: z
      .union([z.literal(0), z.literal(1)])
      .openapi({ description: '1 = positive (👍), 0 = negative (👎)', example: 1 }),
    comment: z
      .string()
      .max(FEEDBACK_COMMENT_MAX_LENGTH)
      .optional()
      .openapi({
        description: `Optional free-text comment from user (max ${FEEDBACK_COMMENT_MAX_LENGTH} characters)`,
      }),
  })
  .openapi('FeedbackInput');

registry.register('FeedbackInput', FeedbackInputSchema);

registry.registerPath({
  method: 'post',
  path: '/feedback',
  summary: 'Submit feedback for a query response',
  description:
    'Records a thumbs-up or thumbs-down score for an orchestratorFlow response. The score is forwarded to Langfuse linked to the given traceId.',
  tags: ['Feedback'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: FeedbackInputSchema } },
    },
  },
  responses: {
    200: {
      description: 'Feedback recorded successfully',
      content: { 'application/json': { schema: z.object({}) } },
    },
    400: {
      description: 'Invalid request body',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: 'Unauthorized — missing or invalid bearer token',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description: 'Internal server error (e.g. Langfuse API failure)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    503: {
      description: 'Feedback storage not configured',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Generate and write the spec
// ---------------------------------------------------------------------------

const generator = new OpenApiGeneratorV31(registry.definitions);

const document = generator.generateDocument({
  openapi: '3.1.0',
  info: {
    title: 'Serapeum API',
    version: '1.0.0',
    description:
      'AI-powered media discovery API. Search for books, movies, TV shows, and video games, or use the orchestrator for natural language queries.',
  },
  servers: [
    { url: 'http://localhost:3000', description: 'Local development' },
    { url: 'https://api.serapeum.app', description: 'Production' },
  ],
});

const yamlString = yaml.stringify(document);

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(__dirname, '../docs/openapi.yaml');

mkdirSync(resolve(__dirname, '../docs'), { recursive: true });
writeFileSync(outputPath, yamlString, 'utf-8');

console.log(`✅ OpenAPI spec written to: ${outputPath}`);
