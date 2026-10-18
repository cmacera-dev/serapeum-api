import type { NextFunction, Request, Response } from 'express';
import type { Action } from '@genkit-ai/core';
import { validateSchema, type ValidationErrorDetail } from '@genkit-ai/core/schema';
import { errorBody } from './errors.js';

/**
 * How many field errors a 400 enumerates. Genkit's `Ajv` is built with the default
 * `allErrors: false`, so today it only ever hands over one — but `jsonSchemaMode:
 * 'interpret'` swaps in a validator that reports them all, and a rejected array can hold one
 * error per element. The cap keeps the answer's size a property of the schema, not of the body.
 */
const MAX_REPORTED_ERRORS = 5;

/** Renders ajv's field errors as one sentence: `comment: must NOT have more than 2000 characters`. */
function describe(errors: ValidationErrorDetail[] | undefined): string {
  if (!errors?.length) return 'The request body does not match the schema for this route.';

  const reported = errors
    .slice(0, MAX_REPORTED_ERRORS)
    .map(({ path, message }) => `${path}: ${message}`)
    .join('; ');
  const omitted = errors.length - MAX_REPORTED_ERRORS;

  return omitted > 0 ? `${reported}; and ${omitted} more.` : `${reported}.`;
}

/**
 * Express gate that answers input-schema rejections itself, before Genkit sees the request —
 * and applies the schema's own defaults to the body on the way through.
 *
 * It has to answer them, for the same reason `requireAuth` does, and this is the other half of
 * #274. A flow whose `inputSchema` rejects raises a `GenkitError` with status
 * `INVALID_ARGUMENT`, and `expressHandler` turns that into a status with `getHttpStatus(e)`,
 * which reads `e.code` only when the error is `instanceof` *its own* `GenkitError`. It never
 * is: `@genkit-ai/express` lists `"default": "./lib/index.js"` ahead of `"import"` in its
 * export map and Node resolves conditions in declaration order, so an ESM import of that
 * package gets the CommonJS build, while `genkit` and `@genkit-ai/core` resolve to their
 * `.mjs`. The class the error carries is therefore never the class the comparison names. So
 * every malformed body — an over-cap `/feedback` comment, an empty `query`, a missing field —
 * came back as `500 {"message":"Internal Error","status":"INTERNAL"}` and was written to the
 * fault log, telling the caller to retry something only they can fix and burying real 5xx in
 * monitoring.
 *
 * `errorHandler`'s `clientErrorStatus` cannot rescue it either: that reads a *numeric* status,
 * while `GenkitError.status` is the string `INVALID_ARGUMENT` — and `expressHandler` has
 * already answered before `next(err)` could ever be reached.
 *
 * Validating here fixes it at the layer that owns HTTP status codes anyway, for every flow
 * route at once. The schema is read off the action itself (`__action.inputSchema`), not
 * imported per flow, so mounting a new route cannot forget it; and the check runs through
 * Genkit's own `validateSchema` — the very function the action calls — so this gate and the
 * action can never disagree about what a valid body is.
 *
 * WHY IT ALSO NORMALISES. `language: z.enum([...]).optional().default('en')` reads as a
 * promise that the field is present by the time the flow body runs, and TypeScript agrees: a
 * flow is typed against its input schema's *output* type, where a defaulted field is required.
 * Genkit never keeps that promise on the unary path. `action.run` validates with
 * `parseSchema`, which calls `validateSchema` and then returns the **original** `data`, and the
 * shared `Ajv` behind it is constructed without `useDefaults`. The one `inputSchema.parse(input)`
 * in Genkit — the call that *would* apply defaults — sits on `actionFn.stream`, which an HTTP
 * flow request never takes. So an omitted field stays `undefined` while the type says it cannot
 * be: `POST /orchestratorFlow {"data":{"query":"dune"}}` validated fine, reached
 * `generateCacheKey(query, undefined)` and died on `language.toLowerCase()` — a 500 in the
 * fault log for a body this API's published schema calls valid. Thirteen `.default()`
 * declarations across the nine flow input schemas sit on that same seam, so the gate closes it
 * once for all of them rather than leaving the next one to be found in production.
 *
 * Normalising here cannot make the gate disagree with the action, in either direction:
 * `validateSchema` remains the only thing that decides valid from invalid, and the Zod parse is
 * best-effort. On the one way the two can diverge — a `.refine()` ajv cannot see in the emitted
 * JSON Schema — it leaves the body exactly as it arrived instead of rejecting a request the
 * action itself would have accepted.
 */
export function validateFlowInput(
  action: Action
): (req: Request, res: Response, next: NextFunction) => void {
  const { inputSchema: schema, inputJsonSchema: jsonSchema } = action.__action;

  return (req: Request, res: Response, next: NextFunction): void => {
    const body = req.body as { data?: unknown } | undefined;
    const result = validateSchema(body?.data, { schema, jsonSchema });

    if (result.valid) {
      if (body && schema) {
        const normalised = schema.safeParse(body.data);
        if (normalised.success) body.data = normalised.data;
      }
      next();
      return;
    }

    // Deliberately not logged, exactly as a rejected token is not: a body the schema refuses is
    // an expected client error. The text comes from the declared schema, which this API already
    // publishes as OpenAPI, so naming the offending field tells the caller nothing it does not
    // already know and is the whole point of a 4xx.
    res.status(400).json(errorBody('invalid_input', describe(result.errors)));
  };
}
