import { describe, it, expect } from 'vitest';
import { FeedbackInputSchema } from '@/flows/feedback/feedbackFlow.js';
import { FEEDBACK_COMMENT_MAX_LENGTH } from '@/lib/constants.js';

/**
 * The comment cap, asserted on the schema itself.
 *
 * Not through a flow call: under vitest the Genkit action wrapper does not apply its input
 * schema, so `feedbackFlow({ comment: 'x'.repeat(100000) })` resolves happily and would make
 * a green test out of no validation at all. Verified separately under plain tsx, where the
 * wrapper does validate: a 2001-character comment is rejected with
 * `INVALID_ARGUMENT: comment: must NOT have more than 2000 characters`.
 *
 * Before the cap, the only ceiling was body-parser's undeclared 100 KB, so one thumbs-down
 * could append ~100 KB of free text to Langfuse, as often as the rate limiter allowed.
 */
describe('FeedbackInputSchema', () => {
  it(`accepts a comment of exactly ${FEEDBACK_COMMENT_MAX_LENGTH} characters`, () => {
    const comment = 'x'.repeat(FEEDBACK_COMMENT_MAX_LENGTH);

    expect(FeedbackInputSchema.safeParse({ traceId: 'a', score: 1, comment }).success).toBe(true);
  });

  it('rejects a longer one', () => {
    const comment = 'x'.repeat(FEEDBACK_COMMENT_MAX_LENGTH + 1);

    expect(FeedbackInputSchema.safeParse({ traceId: 'a', score: 1, comment }).success).toBe(false);
  });

  it('still accepts no comment at all', () => {
    expect(FeedbackInputSchema.safeParse({ traceId: 'a', score: 0 }).success).toBe(true);
  });

  it('keeps the rest of the contract', () => {
    expect(FeedbackInputSchema.safeParse({ traceId: '', score: 1 }).success).toBe(false);
    expect(FeedbackInputSchema.safeParse({ traceId: 'a', score: 5 }).success).toBe(false);
  });
});
