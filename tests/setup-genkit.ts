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
      // Spreading the Genkit instance above copies own properties only, so everything it
      // defines on the prototype is lost. These two are the rest of what the import chain
      // reaches for; without them, importing anything that pulls in src/app.ts throws.
      defineSchema: vi.fn().mockImplementation((_name, schema) => schema),
      defineEvaluator: vi.fn().mockImplementation((_config, fn) => fn),
      // `ai.prompt(name)` normally resolves a dotprompt off disk. Tests that exercise a
      // prompt mock it themselves; this stub only has to let the module import succeed.
      prompt: vi.fn().mockImplementation(() => vi.fn()),
    },
    // Keep real z
    z: z,
  };
});
