import { describe, it, expect } from 'vitest';
import { inspect } from 'node:util';
import axios, { AxiosError } from 'axios';
import { summarizeError } from '../../../src/lib/errorSummary.js';

/**
 * The reason this helper exists is a provider key reaching the logs, so the tests are about
 * a sentinel never appearing — including through a *real* AxiosError, whose `request` object
 * carries the full request line as primitive own properties. Asserting against a hand-built
 * object would miss exactly that.
 */
const SENTINEL = 'SENTINELKEY123';

/** Makes a genuine network-error AxiosError: nothing listens on port 1. */
async function realNetworkError(): Promise<unknown> {
  try {
    await axios.get('http://127.0.0.1:1/3/search/multi', {
      params: { api_key: SENTINEL, query: 'x', page: 1 },
      timeout: 2000,
    });
    throw new Error('the request was expected to fail');
  } catch (error) {
    // What the tools do: keep the AxiosError as `cause` behind a readable message.
    return new Error('Network error: Unable to reach TMDB API.', { cause: error });
  }
}

describe('summarizeError', () => {
  it('keeps no trace of a key held in axios params', () => {
    const config = {
      url: 'https://api.themoviedb.org/3/search/multi',
      method: 'get',
      params: { api_key: SENTINEL, query: 'x' },
    } as never;
    const response = { status: 500, statusText: 'Internal Server Error', data: {} } as never;
    const axiosError = new AxiosError('Request failed', 'ERR_BAD_RESPONSE', config, {}, response);
    const thrown = new Error('TMDB API error (500): Internal Server Error', {
      cause: axiosError,
    });

    const summary = summarizeError(thrown);

    expect(summary).not.toContain(SENTINEL);
    // ...and it is still worth reading: the status is what tells a 401 from a 502.
    expect(summary).toContain('status=500');
    expect(summary).toContain('ERR_BAD_RESPONSE');
    expect(summary).toContain('TMDB API error (500)');
  });

  it('keeps no trace of a key held by a real request object', async () => {
    const thrown = await realNetworkError();

    // Both shapes the old code used leaked it; this is the proof the sanitised line does not.
    expect(inspect(thrown, { depth: null })).toContain(SENTINEL);
    expect(inspect(thrown)).toContain(SENTINEL);
    expect(summarizeError(thrown)).not.toContain(SENTINEL);
  });

  it('walks the cause chain', () => {
    const root = new Error('getaddrinfo EAI_AGAIN api.themoviedb.org');
    const middle = new Error('Request failed', { cause: root });
    const top = new Error('Network error', { cause: middle });

    expect(summarizeError(top)).toBe(
      'Error: Network error <- caused by Error: Request failed <- caused by ' +
        'Error: getaddrinfo EAI_AGAIN api.themoviedb.org'
    );
  });

  it('survives a cause cycle rather than hanging the log call', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;

    expect(summarizeError(a).split('<- caused by').length).toBeLessThanOrEqual(5);
  });

  it('handles a thrown non-error', () => {
    expect(summarizeError('just a string')).toBe('just a string');
    expect(summarizeError(undefined)).toBe('');
  });
});
