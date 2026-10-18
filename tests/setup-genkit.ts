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
      // A flow here is the bare implementation function, so a test can call it directly —
      // but `createApp` reads each flow's declared input schema off `__action` to mount the
      // validation gate, exactly as Genkit's own Express adapter does. Without it the mock is
      // unfaithful enough to make `createApp` throw, which is how it used to behave. Note what
      // this still does NOT provide: `run`, which is what Genkit dispatches through, so no
      // test here can execute a flow *body* over HTTP. Only the layers that answer before
      // dispatch — `requireAuth`, and the input gate — are observable over a socket.
      defineFlow: vi.fn().mockImplementation(
        (
          config: {
            name?: string;
            inputSchema?: unknown;
            outputSchema?: unknown;
          },
          fn: (...args: unknown[]) => unknown
        ) =>
          Object.assign(fn, {
            __action: {
              name: config.name,
              inputSchema: config.inputSchema,
              outputSchema: config.outputSchema,
            },
          })
      ),
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
