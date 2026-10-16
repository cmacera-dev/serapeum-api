import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  cacheAsync,
  generateCacheKey,
  getCachedResponse,
  setCachedResponse,
} from '@/lib/queryCache.js';
import type { AgentResponse } from '@serapeum/shared-schemas';

const SUPABASE_URL = 'https://test.supabase.co';
const SERVICE_ROLE_KEY = 'service-role-key-test';

const cachedResponse: AgentResponse = {
  kind: 'search_results',
  message: 'Here are some results',
  data: { media: [], books: [], games: [] },
  traceId: 'trace-abc',
};

describe('generateCacheKey', () => {
  it('returns a 16-character hex string', () => {
    const key = generateCacheKey('Inception', 'en');
    expect(key).toHaveLength(16);
    expect(key).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic for the same input', () => {
    expect(generateCacheKey('Inception', 'en')).toBe(generateCacheKey('Inception', 'en'));
  });

  it('lowercases the query before hashing', () => {
    expect(generateCacheKey('INCEPTION', 'en')).toBe(generateCacheKey('inception', 'en'));
  });

  it('trims whitespace before hashing', () => {
    expect(generateCacheKey('  Inception  ', 'en')).toBe(generateCacheKey('Inception', 'en'));
  });

  it('produces different keys for different languages', () => {
    expect(generateCacheKey('Inception', 'en')).not.toBe(generateCacheKey('Inception', 'es'));
  });

  it('lowercases the language before hashing', () => {
    expect(generateCacheKey('Inception', 'EN')).toBe(generateCacheKey('Inception', 'en'));
  });

  it('produces different keys for different queries', () => {
    expect(generateCacheKey('Inception', 'en')).not.toBe(generateCacheKey('Matrix', 'en'));
  });
});

describe('getCachedResponse', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env['SUPABASE_URL'] = SUPABASE_URL;
    process.env['SUPABASE_SERVICE_ROLE_KEY'] = SERVICE_ROLE_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('returns null when SUPABASE_URL is not set', async () => {
    delete process.env['SUPABASE_URL'];
    const result = await getCachedResponse('somekey');
    expect(result).toBeNull();
  });

  it('returns null when SUPABASE_SERVICE_ROLE_KEY is not set', async () => {
    delete process.env['SUPABASE_SERVICE_ROLE_KEY'];
    const result = await getCachedResponse('somekey');
    expect(result).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    const result = await getCachedResponse('somekey');
    expect(result).toBeNull();
  });

  it('returns null when response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response));
    const result = await getCachedResponse('somekey');
    expect(result).toBeNull();
  });

  it('returns null when rows array is empty (cache miss)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      } as unknown as Response)
    );
    const result = await getCachedResponse('somekey');
    expect(result).toBeNull();
  });

  it('returns the cached response on a hit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([{ response: cachedResponse }]),
      } as unknown as Response)
    );
    const result = await getCachedResponse('somekey');
    expect(result).toEqual(cachedResponse);
  });

  it('sends correct headers to Supabase', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ response: cachedResponse }]),
    } as unknown as Response);
    vi.stubGlobal('fetch', mockFetch);

    await getCachedResponse('abc123');

    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`${SUPABASE_URL}/rest/v1/query_cache`);
    expect(url).toContain('key=eq.abc123');
    expect((options.headers as Record<string, string>)['apikey']).toBe(SERVICE_ROLE_KEY);
    expect((options.headers as Record<string, string>)['Authorization']).toBe(
      `Bearer ${SERVICE_ROLE_KEY}`
    );
  });
});

describe('setCachedResponse', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env['SUPABASE_URL'] = SUPABASE_URL;
    process.env['SUPABASE_SERVICE_ROLE_KEY'] = SERVICE_ROLE_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('does nothing when SUPABASE_URL is not set', async () => {
    delete process.env['SUPABASE_URL'];
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    await setCachedResponse('somekey', cachedResponse);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does nothing when SUPABASE_SERVICE_ROLE_KEY is not set', async () => {
    delete process.env['SUPABASE_SERVICE_ROLE_KEY'];
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    await setCachedResponse('somekey', cachedResponse);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('swallows errors silently', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    await expect(setCachedResponse('somekey', cachedResponse)).resolves.toBeUndefined();
  });

  it('sends a POST with the correct body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal('fetch', mockFetch);

    await setCachedResponse('abc123', cachedResponse);

    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SUPABASE_URL}/rest/v1/query_cache`);
    expect(options.method).toBe('POST');
    const body = JSON.parse(options.body as string);
    expect(body.key).toBe('abc123');
    expect(body.response).toEqual(cachedResponse);
    expect(body.expires_at).toBeDefined();
  });

  it('sends correct headers including Prefer: resolution=merge-duplicates', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal('fetch', mockFetch);

    await setCachedResponse('abc123', cachedResponse);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers['apikey']).toBe(SERVICE_ROLE_KEY);
    expect(headers['Authorization']).toBe(`Bearer ${SERVICE_ROLE_KEY}`);
    expect(headers['Prefer']).toBe('resolution=merge-duplicates');
  });

  it('uses CACHE_TTL_SECONDS env var to compute expires_at', async () => {
    process.env['CACHE_TTL_SECONDS'] = '3600';
    const mockFetch = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal('fetch', mockFetch);

    const before = Date.now();
    await setCachedResponse('abc123', cachedResponse);
    const after = Date.now();

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    const expiresAt = new Date(body.expires_at as string).getTime();

    expect(expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(after + 3600 * 1000);
  });
});

describe('cacheAsync', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env['SUPABASE_URL'] = SUPABASE_URL;
    process.env['SUPABASE_SERVICE_ROLE_KEY'] = SERVICE_ROLE_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  /** Resolves once the fire-and-forget write has had a turn to run. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

  it('writes a sound response and returns it unchanged', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    expect(cacheAsync('somekey', cachedResponse)).toBe(cachedResponse);
    await settle();

    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('refuses to write a response the caller marked degraded', async () => {
    // The whole point: a degraded answer is shaped exactly like a sound one, so the gate
    // cannot read it off `kind`. Stored, it would be served to every caller for the TTL.
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    expect(cacheAsync('somekey', cachedResponse, { degraded: true })).toBe(cachedResponse);
    await settle();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('writes when degraded is explicitly false', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    cacheAsync('somekey', cachedResponse, { degraded: false });
    await settle();

    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('never writes an error response, degraded or not', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const errorResponse: AgentResponse = {
      kind: 'error',
      error: 'Router failure',
      details: 'nope',
    };

    cacheAsync('somekey', errorResponse);
    cacheAsync('somekey', errorResponse, { degraded: false });
    await settle();

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
