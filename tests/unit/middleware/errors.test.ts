import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { errorHandler, notFoundHandler } from '../../../src/middleware/errors.js';

// A miniature app with the same terminal handlers as the real one, exercised over real
// HTTP so the assertions cover what a client actually receives.
let server: Server;
let origin: string;

beforeAll(async () => {
  const app = express();
  // Same declared limit as the real app, small enough to exceed in a test.
  app.use(express.json({ limit: '1kb' }));

  app.get('/ok', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.post('/echo', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/boom', () => {
    throw new Error('secret internal detail: postgres://user:pw@host/db');
  });
  app.get('/teapot', () => {
    throw Object.assign(new Error('I refuse'), { status: 418 });
  });
  app.get('/upstream-500', () => {
    // A 5xx carried by the error is still a server fault and must not be passed through.
    throw Object.assign(new Error('upstream exploded'), { status: 502 });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  origin = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('notFoundHandler', () => {
  it('answers unknown routes with JSON, not Express default HTML', async () => {
    const response = await fetch(`${origin}/does-not-exist`);

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');

    const body = await response.json();
    expect(body).toMatchObject({ status: 'error', error: 'not_found' });
    expect(body.message).toContain('/does-not-exist');
    expect(body.timestamp).toEqual(expect.any(String));
  });

  it('leaves real routes alone', async () => {
    const response = await fetch(`${origin}/ok`);
    expect(response.status).toBe(200);
  });
});

describe('errorHandler', () => {
  it('reports malformed JSON as a 400 the caller can act on', async () => {
    const response = await fetch(`${origin}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ status: 'error', error: 'invalid_json' });
  });

  it('keeps a 4xx the error already carries, instead of calling it a server fault', async () => {
    // body-parser raises PayloadTooLargeError with status 413. That used to be answered as
    // 500 internal_error: the caller could not tell "your request is too big" from "the
    // server is down", and every oversized body was logged as a fault.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await fetch(`${origin}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ comment: 'x'.repeat(2048) }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ status: 'error', error: 'bad_request' });
    // A client error is not a fault, so it does not go to the fault log.
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('passes through any 4xx, not just the ones body-parser raises', async () => {
    const response = await fetch(`${origin}/teapot`);

    expect(response.status).toBe(418);
    // Still generic: the status is the useful part, the message is not.
    expect(await response.text()).not.toContain('I refuse');
  });

  it('answers 500 for a 5xx carried by the error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await fetch(`${origin}/upstream-500`);

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ status: 'error', error: 'internal_error' });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('never leaks the exception message to the client', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await fetch(`${origin}/boom`);
    const raw = await response.text();

    expect(response.status).toBe(500);
    expect(raw).not.toContain('postgres://');
    expect(raw).not.toContain('secret internal detail');
    expect(JSON.parse(raw)).toMatchObject({ status: 'error', error: 'internal_error' });

    // The detail is not lost — it goes to the server log instead.
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
