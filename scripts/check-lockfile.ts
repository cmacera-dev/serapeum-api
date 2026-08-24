/**
 * Lockfile integrity guard
 *
 * `npm install` on macOS arm64 quietly prunes lockfile entries that only a different
 * platform needs — most notably `@emnapi/core` and `@emnapi/runtime`, which
 * `@rolldown/binding-wasm32-wasi` still declares as dependencies. The lockfile looks fine
 * locally and then Linux CI dies on `npm ci`.
 *
 * This walks every entry in package-lock.json and resolves each of its declared
 * dependencies the way npm would — nearest `node_modules` first, then up the chain.
 * Anything that cannot be resolved means the lockfile is internally inconsistent.
 *
 * Run with: npm run check:lockfile
 */

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const lockPath = resolve(__dirname, '../package-lock.json');

interface LockEntry {
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  link?: boolean;
}

interface Lockfile {
  packages: Record<string, LockEntry>;
}

const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as Lockfile;
const paths = new Set(Object.keys(lock.packages));

/**
 * Resolve `name` from a package living at `from`, following npm's lookup order: the
 * package's own node_modules first, then each ancestor's, ending at the root.
 *
 * `node_modules/a/node_modules/b` looking for `x` tries, in order:
 *   node_modules/a/node_modules/b/node_modules/x
 *   node_modules/a/node_modules/x
 *   node_modules/x
 */
function resolves(from: string, name: string): boolean {
  let scope = from;

  for (;;) {
    if (paths.has(`${scope === '' ? '' : `${scope}/`}node_modules/${name}`)) return true;

    const cut = scope.lastIndexOf('/node_modules/');
    if (cut === -1) break;
    scope = scope.slice(0, cut);
  }

  return paths.has(`node_modules/${name}`);
}

interface Missing {
  from: string;
  dependency: string;
  range: string;
}

const missing: Missing[] = [];

for (const [path, entry] of Object.entries(lock.packages)) {
  // Workspace links have no tree of their own; the root entry is the project itself.
  if (path === '' || entry.link === true) continue;

  const declared = {
    ...(entry.dependencies ?? {}),
    ...(entry.optionalDependencies ?? {}),
  };

  for (const [dependency, range] of Object.entries(declared)) {
    if (!resolves(path, dependency)) {
      missing.push({ from: path, dependency, range });
    }
  }
}

if (missing.length === 0) {
  console.log(`✅ package-lock.json is internally consistent (${paths.size} entries checked).`);
  process.exit(0);
}

console.error('❌ package-lock.json is missing entries that other entries depend on.\n');
for (const entry of missing) {
  console.error(`   ${entry.from}`);
  console.error(`     needs ${entry.dependency}@${entry.range} — no entry resolves it\n`);
}
console.error('This usually means `npm install` ran on macOS and pruned entries that Linux CI');
console.error('needs. Restore them from main:\n');
console.error('   git show main:package-lock.json > /tmp/main-lock.json');
console.error('   # then re-insert the missing entries, keeping the packages keys sorted\n');
process.exit(1);
