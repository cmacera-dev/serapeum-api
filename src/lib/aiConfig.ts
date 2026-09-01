import { z } from '@genkit-ai/core';
import type { GenkitPlugin, GenkitPluginV2 } from 'genkit/plugin';
import { googleAI } from '@genkit-ai/google-genai';
import { ollama } from 'genkitx-ollama';
import { openAI } from 'genkitx-openai';

/**
 * Configure Google AI plugin.
 * Defaults to Google AI if no other provider is properly configured,
 * but strictly requires API key to function.
 */
export const googlePlugin = (): GenkitPlugin | GenkitPluginV2 | null => {
  if (!process.env['GOOGLE_GENAI_API_KEY']) return null;
  return googleAI();
};

/**
 * Configure Ollama plugin.
 * Returns null if OLLAMA_SERVER_URL is missing.
 * Fetches all available models from Ollama at startup so they are all
 * pre-registered as Genkit actions — required for the Genkit eval UI to
 * initialize the model config editor for any selected model.
 */
export const ollamaPlugin = async (): Promise<GenkitPlugin | null> => {
  const serverAddress = process.env['OLLAMA_SERVER_URL'];
  const modelName = process.env['OLLAMA_MODEL'];

  if (!serverAddress || process.env['AI_PROVIDER'] === 'ollama-cloud') return null;

  let models: { name: string }[] = [];
  try {
    const res = await fetch(`${serverAddress}/api/tags`);
    if (!res.ok) throw new Error(`Ollama /api/tags returned ${res.status} ${res.statusText}`);
    const data = (await res.json()) as { models?: Array<{ model: string }> };
    models =
      data.models
        ?.filter((m) => m.model && !m.model.includes('embed'))
        .map((m) => ({ name: m.model })) ?? [];
  } catch {
    // Ollama unreachable at startup — fall back to OLLAMA_MODEL only
    if (modelName) models = [{ name: modelName }];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config: any = { serverAddress };
  if (models.length > 0) config.models = models;

  return ollama(config);
};

/**
 * Configure Ollama Cloud plugin for production deployments.
 * Uses https://ollama.com/api with Bearer token auth.
 * Returns null if OLLAMA_CLOUD_API_KEY is missing.
 */
export const ollamaCloudPlugin = (): GenkitPlugin | null => {
  const apiKey = process.env['OLLAMA_CLOUD_API_KEY'];
  const modelName = process.env['OLLAMA_CLOUD_MODEL'];

  if (!apiKey || process.env['AI_PROVIDER'] !== 'ollama-cloud') return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config: any = {
    serverAddress: 'https://ollama.com',
    requestHeaders: { Authorization: `Bearer ${apiKey}` },
  };
  if (modelName) config.models = [{ name: modelName }];

  return ollama(config);
};

/**
 * Configure OpenRouter plugin.
 * Returns null if OPENROUTER_API_KEY is missing.
 */
export const openRouterPlugin = (): GenkitPlugin | null => {
  const apiKey = process.env['OPENROUTER_API_KEY'];
  const modelName = process.env['OPENROUTER_MODEL'];

  if (!apiKey || !modelName) return null;

  return openAI({
    apiKey: apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
    models: [
      {
        name: modelName,
        info: {
          label: `OpenRouter - ${modelName}`,
          supports: { multiturn: true, tools: true, media: false, output: ['text', 'json'] },
          versions: [],
        },
        configSchema: z.object({}).passthrough(),
      },
    ],
  });
};
