import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { z } from 'zod';
import type { Server } from 'http';
import type { Action } from '@genkit-ai/core';
import { validateFlowInput } from '../../../src/middleware/validateFlowInput.js';

/**
 * The gate does two jobs, and this file is about the second one: it answers a rejected body
 * with a 400 (asserted end to end in `tests/integration/http/flowInputValidation.test.ts`),
 * and it applies the input schema's declared defaults before the flow runs.
 *
 * Genkit does not apply them. `action.run` validates through `parseSchema`, which returns the
 * original `data`, over an `Ajv` built without `useDefaults`; the one `inputSchema.parse(input)`
 * that would apply them is on `actionFn.stream`, which an HTTP request never reaches. So
 * `{"query":"dune"}` against `orchestratorFlow` left `language` undefined while the flow's own
 * inferred type says it cannot be, and `generateCacheKey` died on `language.toLowerCase()`:
 * a 500 for a body the published schema calls valid.
 *
 * These drive a miniature app over a real socket, with a terminal handler that echoes back
 * whatever reached it, because what the flow *receives* is the whole claim.
 */

/** A flow-shaped stand-in: the gate reads nothing but `__action`. */
function actionWith(inputSchema: z.ZodTypeAny | undefined): Action {
  return { __action: { inputSchema } } as unknown as Action;
}

const DEFAULTS = z.object({
  query: z.string().min(1),
  language: z.enum(['en', 'es']).optional().default('en'),
  page: z.number().int().positive().optional().default(1),
  options: z.object({ depth: z.string().optional().default('basic') }).optional(),
});

// A constraint ajv cannot see in the emitted JSON Schema, so `validateSchema` accepts a body
// that Zod then refuses. The gate must not become stricter than the action it fronts.
const REFINED = z.object({
  query: z.string(),
  language: z.enum(['en', 'es']).optional().default('en'),
});
const REFINED_INVISIBLE = REFINED.refine((v) => v.query !== 'forbidden', {
  message: 'ajv cannot see this',
});

let server: Server;
let origin: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());

  const echo = (path: string, schema: z.ZodTypeAny | undefined): void => {
    app.post(path, validateFlowInput(actionWith(schema)), (req, res) => {
      res.json({ received: (req.body as { data?: unknown }).data ?? null });
    });
  };

  echo('/defaults', DEFAULTS);
  echo('/refined', REFINED_INVISIBLE);
  echo('/no-schema', undefined);

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

async function post(path: string, data: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data }),
  });
  return { status: res.status, body: await res.json() };
}

describe('the gate applies the input schema defaults', () => {
  it('fills in a field the body omits', async () => {
    const { status, body } = await post('/defaults', { query: 'dune' });

    expect(status).toBe(200);
    expect(body).toEqual({ received: { query: 'dune', language: 'en', page: 1 } });
  });

  it('leaves a value the caller did supply alone', async () => {
    const { body } = await post('/defaults', { query: 'dune', language: 'es', page: 3 });

    expect(body).toEqual({ received: { query: 'dune', language: 'es', page: 3 } });
  });

  it('reaches defaults nested inside an object the caller did supply', async () => {
    const { body } = await post('/defaults', { query: 'dune', options: {} });

    expect(body).toMatchObject({ received: { options: { depth: 'basic' } } });
  });

  it('leaves an absent optional object absent rather than inventing one', async () => {
    const { body } = await post('/defaults', { query: 'dune' });

    expect(body).not.toHaveProperty('received.options');
  });
});

describe('normalising never changes the verdict', () => {
  it('still answers 400 for a body the schema rejects, and hands the flow nothing', async () => {
    const { status, body } = await post('/defaults', { query: '' });

    expect(status).toBe(400);
    expect(body).toMatchObject({ status: 'error', error: 'invalid_input' });
    expect(body).not.toHaveProperty('received');
  });

  it('passes a body ajv accepts but Zod refuses, untouched', async () => {
    // `validateSchema` is what decides valid from invalid, and it cannot see the `.refine()`.
    // Rejecting here would turn away a request the action itself would run, so the gate lets
    // it through exactly as it arrived — without the default it could not safely apply.
    const { status, body } = await post('/refined', { query: 'forbidden' });

    expect(status).toBe(200);
    expect(body).toEqual({ received: { query: 'forbidden' } });
  });

  it('still normalises a body that satisfies the refinement too', async () => {
    const { body } = await post('/refined', { query: 'dune' });

    expect(body).toEqual({ received: { query: 'dune', language: 'en' } });
  });

  it('passes the body through for an action that declares no input schema', async () => {
    const { status, body } = await post('/no-schema', { anything: true });

    expect(status).toBe(200);
    expect(body).toEqual({ received: { anything: true } });
  });
});
