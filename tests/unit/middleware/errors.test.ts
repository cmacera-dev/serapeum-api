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
  app.use(express.json());

  app.get('/ok', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.post('/echo', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/boom', () => {
    throw new Error('secret internal detail: postgres://user:pw@host/db');
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
