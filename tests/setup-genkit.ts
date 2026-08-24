import { vi } from 'vitest';
import { z } from 'zod';

// Mock only the genkit-specific parts that have side effects
// Allow z to work normally as it's used in tool/flow definitions
vi.mock('../src/lib/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/ai.js')>();
  return {
    ...actual,
    ai: {
      ...actual.ai,
      generate: vi.fn(),
      defineFlow: vi.fn().mockImplementation((_config, fn) => fn),
      defineTool: vi.fn().mockImplementation((_config, fn) => fn),
    },
    // Keep real z
    z: z,
  };
});
