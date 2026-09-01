import { ai, activeModel, z } from '../lib/ai.js';
import { extractTextOutput } from './utils.js';

type SynthesizerInput = {
  originalQuery: string;
  webContext: string;
  apiDetails: string;
  language?: string;
};

type ApiDetails = {
  featured?: {
    item: { title?: string; name?: string };
  };
};

// --- Metric 1: Length compliance ---

/**
 * Checks that the synthesizer output does not exceed 350 characters.
 * Score 1 = compliant, 0 = too long.
 */
export const synthesizerLengthEvaluator = ai.defineEvaluator(
  {
    name: 'synthesizer/length',
    displayName: 'Synthesizer Length Compliance',
    definition:
      'Binary check: score 1 if response is ≤ 350 characters, score 0 if it exceeds the limit.',
    isBilled: false,
  },
  async (datapoint) => {
    const output = extractTextOutput(datapoint.output);

    if (output === null) {
      return {
        testCaseId: datapoint.testCaseId,
        evaluation: { score: undefined, rationale: 'Could not extract text output' },
      };
    }

    const length = output.length;
    const score = length <= 350 ? 1 : 0;

    return {
      testCaseId: datapoint.testCaseId,
      evaluation: {
        score,
        rationale: `${length} chars (limit: 350)`,
      },
    };
  }
);

// --- Metric 2: Featured item mention ---

/**
 * Returns true if featuredName appears in output, using a word-boundary regex
 * for single-token names to avoid false positives on substring matches.
 */
function checkMentioned(output: string, featuredName: string): boolean {
  if (featuredName.includes(' ')) {
    return output.toLowerCase().includes(featuredName);
  }
  const escaped = featuredName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(output);
}

/**
 * Checks that the featured item name appears in the response when one exists.
 * Score 1 = present (or no featured), 0 = featured exists but omitted.
 * Returns indeterminate for titles ≤ 3 characters (too ambiguous for reliable matching).
 */
export const synthesizerFeaturedMentionEvaluator = ai.defineEvaluator(
  {
    name: 'synthesizer/featured-mention',
    displayName: 'Synthesizer Featured Item Mention',
    definition:
      'Checks that the featured item name appears in the response when apiDetails contains a featured entry. Score 1 = present (or no featured), 0 = featured exists but not mentioned.',
    isBilled: false,
  },
  async (datapoint) => {
    const input = datapoint.input as SynthesizerInput;
    const output = extractTextOutput(datapoint.output);

    if (output === null) {
      return {
        testCaseId: datapoint.testCaseId,
        evaluation: { score: undefined, rationale: 'Could not extract text output' },
      };
    }

    let apiData: ApiDetails;
    try {
      apiData = JSON.parse(input.apiDetails) as ApiDetails;
    } catch {
      return {
        testCaseId: datapoint.testCaseId,
        evaluation: {
          score: undefined,
          rationale: 'Could not parse apiDetails — invalid test data',
        },
      };
    }

    if (!apiData?.featured) {
      return {
        testCaseId: datapoint.testCaseId,
        evaluation: { score: undefined, rationale: 'No featured item — metric N/A' },
      };
    }

    const featuredName = (
      apiData.featured.item.title ??
      apiData.featured.item.name ??
      ''
    ).toLowerCase();

    if (!featuredName) {
      return {
        testCaseId: datapoint.testCaseId,
        evaluation: { score: undefined, rationale: 'Featured item has no identifiable name' },
      };
    }

    if (featuredName.length <= 3) {
      return {
        testCaseId: datapoint.testCaseId,
        evaluation: {
          score: undefined,
          rationale: `featured: "${featuredName}" — too short for reliable match`,
        },
      };
    }

    const mentioned = checkMentioned(output, featuredName);

    return {
      testCaseId: datapoint.testCaseId,
      evaluation: {
        score: mentioned ? 1 : 0,
        rationale: `featured: "${featuredName}" | in response: ${mentioned}`,
      },
    };
  }
);

// --- Metric 3: LLM-based relevance ---

const relevanceScoreSchema = z.object({
  score: z.number().int().min(1).max(5),
});

/**
 * LLM judge that scores relevance and coherence of the synthesizer response (1–5, normalised to 0–1).
 * isBilled: true — this evaluator makes LLM API calls.
 *
 * Run selectively:
 *   genkit eval:run .genkit/datasets/synthesizer-cases.json --flow synthesizerPrompt --evaluators synthesizer/relevance
 */
export const synthesizerRelevanceEvaluator = ai.defineEvaluator(
  {
    name: 'synthesizer/relevance',
    displayName: 'Synthesizer Relevance (LLM-based)',
    definition:
      'LLM judge rates relevance and coherence of the synthesizer response on a 1–5 scale, normalised to 0–1.',
    isBilled: true,
  },
  async (datapoint) => {
    const input = datapoint.input as SynthesizerInput;
    const output = extractTextOutput(datapoint.output);

    if (output === null) {
      return {
        testCaseId: datapoint.testCaseId,
        evaluation: { score: undefined, rationale: 'Could not extract text output' },
      };
    }

    let rawScore: number;
    try {
      const result = await ai.generate({
        model: activeModel,
        prompt: `You are evaluating a media assistant response for relevance and quality.

Original query: "${input.originalQuery}"
Response: "${output}"

Rate the response from 1 to 5:
5 = Perfectly relevant, engaging, accurate to the query
4 = Mostly relevant with minor issues
3 = Somewhat relevant but could be better
2 = Marginally relevant, mostly misses the point
1 = Completely irrelevant or unhelpful

Return only the JSON with the score.`,
        output: { schema: relevanceScoreSchema },
        config: { temperature: 0 },
      });

      if (!result.output?.score) {
        return {
          testCaseId: datapoint.testCaseId,
          evaluation: { score: undefined, rationale: 'LLM returned no valid score' },
        };
      }

      rawScore = result.output.score;
    } catch (err) {
      return {
        testCaseId: datapoint.testCaseId,
        evaluation: {
          score: undefined,
          rationale: `LLM evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }

    const normalized = (rawScore - 1) / 4; // maps 1→0, 5→1

    return {
      testCaseId: datapoint.testCaseId,
      evaluation: {
        score: normalized,
        rationale: `LLM rated: ${rawScore}/5 → normalised: ${normalized.toFixed(2)}`,
      },
    };
  }
);
