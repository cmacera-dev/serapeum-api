import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConfigError, parsePort, resolveCorsOrigins } from '../../../src/lib/env.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parsePort', () => {
  it('parses a valid port', () => {
    expect(parsePort('8080', 3000)).toBe(8080);
  });

  it('falls back silently when the value is absent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parsePort(undefined, 3000)).toBe(3000);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['not-a-number', 'non-numeric'],
    ['0', 'below the valid range'],
    ['65536', 'above the valid range'],
    ['-1', 'negative'],
  ])('falls back and warns for %s (%s)', (value) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parsePort(value, 3000)).toBe(3000);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('resolveCorsOrigins', () => {
  it('returns a bare string for a single origin, as the cors package expects', () => {
    expect(resolveCorsOrigins({ CORS_ORIGINS: 'https://serapeum.app' })).toBe(
      'https://serapeum.app'
    );
  });

  it('returns an array for several origins', () => {
    expect(
      resolveCorsOrigins({ CORS_ORIGINS: 'https://serapeum.app,https://staging.serapeum.app' })
    ).toEqual(['https://serapeum.app', 'https://staging.serapeum.app']);
  });

  it('trims whitespace around each origin', () => {
    expect(resolveCorsOrigins({ CORS_ORIGINS: ' https://a.app , https://b.app ' })).toEqual([
      'https://a.app',
      'https://b.app',
    ]);
  });

  it('ignores empty entries from a trailing comma', () => {
    expect(resolveCorsOrigins({ CORS_ORIGINS: 'https://a.app,' })).toBe('https://a.app');
  });

  it('defaults to "*" with a warning outside production', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveCorsOrigins({ NODE_ENV: 'development' })).toBe('*');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('refuses to default to "*" in production', () => {
    expect(() => resolveCorsOrigins({ NODE_ENV: 'production' })).toThrow(ConfigError);
  });

  it('refuses a production value that is only whitespace and commas', () => {
    // Would otherwise parse to an empty list and silently open the API to every origin.
    expect(() => resolveCorsOrigins({ NODE_ENV: 'production', CORS_ORIGINS: ' , ' })).toThrow(
      ConfigError
    );
  });
});
