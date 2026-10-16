import { GenkitError } from 'genkit';
import { ai, z } from '../../lib/ai.js';
import { FEEDBACK_COMMENT_MAX_LENGTH } from '../../lib/constants.js';

/**
 * Exported so the cap can be asserted directly: under vitest the Genkit action wrapper does
 * not apply its input schema, so a test that calls the flow proves nothing about validation.
 */
export const FeedbackInputSchema = z.object({
  traceId: z.string().min(1),
  score: z.union([z.literal(0), z.literal(1)]),
  comment: z.string().max(FEEDBACK_COMMENT_MAX_LENGTH).optional(),
});

export const feedbackFlow = ai.defineFlow(
  {
    name: 'feedback',
    inputSchema: FeedbackInputSchema,
    outputSchema: z.object({}),
  },
  async ({ traceId, score, comment }) => {
    const publicKey = process.env['LANGFUSE_PUBLIC_KEY'];
    const secretKey = process.env['LANGFUSE_SECRET_KEY'];

    if (!publicKey || !secretKey) {
      throw new GenkitError({
        status: 'UNAVAILABLE',
        message: 'Feedback storage is not configured.',
      });
    }

    const host = (process.env['LANGFUSE_HOST'] ?? 'https://cloud.langfuse.com').replace(/\/$/, '');
    const credentials = Buffer.from(`${publicKey}:${secretKey}`).toString('base64');

    const body: Record<string, unknown> = {
      traceId,
      name: 'user-feedback',
      value: score,
      dataType: 'NUMERIC',
    };
    if (comment) body['comment'] = comment;

    const res = await fetch(`${host}/api/public/scores`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GenkitError({
        status: 'INTERNAL',
        message: `Langfuse score submission failed (${res.status}): ${text}`,
      });
    }

    return {};
  }
);
