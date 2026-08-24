/**
 * Environment parsing shared by both entrypoints.
 *
 * There are two ways this API boots — `src/index.ts` for the standalone server and
 * `api/index.ts` for Vercel — and they used to parse the same variables separately. They
 * had already drifted: one collapsed a single CORS origin to a string, the other always
 * passed an array. CORS configuration maintained in two places is a bug waiting to happen,
 * so it lives here instead.
 */

/**
 * Thrown when configuration is missing or invalid in a way that must not be defaulted
 * away. Callers decide how to react: the standalone server logs and exits, while the
 * serverless entrypoint lets it propagate and fail the invocation loudly.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Parses a port, falling back when the value is absent or out of range. */
export function parsePort(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? '', 10);

  if (isNaN(parsed) || parsed <= 0 || parsed > 65535) {
    if (value !== undefined) {
      console.warn(`⚠️ Invalid PORT "${value}", using fallback: ${fallback}`);
    }
    return fallback;
  }

  return parsed;
}

/**
 * Resolves the allowed CORS origins from `CORS_ORIGINS`.
 *
 * A single origin is returned as a string and several as an array, which is what the
 * `cors` package expects in each case. Wide-open `*` is only ever returned outside
 * production; in production a missing value is a ConfigError rather than a silent default,
 * because defaulting to `*` there would quietly expose the API to every origin.
 */
export function resolveCorsOrigins(env: NodeJS.ProcessEnv = process.env): string | string[] {
  const raw = env['CORS_ORIGINS'];
  const isProduction = env['NODE_ENV'] === 'production';

  const origins =
    raw
      ?.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin !== '') ?? [];

  if (origins.length === 0) {
    if (isProduction) {
      throw new ConfigError('CORS_ORIGINS is required in production.');
    }
    console.warn('⚠️ CORS_ORIGINS not set, defaulting to "*" for development.');
    return '*';
  }

  return origins.length === 1 ? (origins[0] as string) : origins;
}
