/**
 * Dependency blocker & security watchdog
 *
 * Every dependency this repo deliberately holds back is held back for a reason, and every
 * reason eventually expires upstream. This script re-tests those reasons on a schedule so
 * nothing rots silently. It answers three questions:
 *
 *   1. BLOCKERS  — are the upstream constraints that force us to pin something still real?
 *   2. OVERRIDES — is any `overrides` entry in package.json redundant now?
 *   3. ADVISORIES — is there a vulnerability no override covers yet?
 *
 * Prints a markdown report on stdout. When running inside GitHub Actions it also writes
 * `actionable` and `report_file` to $GITHUB_OUTPUT, so the workflow only pings when there
 * is something a human has to do.
 *
 * Run locally with: npm run check:blockers
 */

import { execFileSync } from 'child_process';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Small semver helpers. Deliberately not pulling in the `semver` package: it is
// only present transitively, and depending on a transitive package is a trap.
// ---------------------------------------------------------------------------

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

/** First `x.y.z` found in a string. Handles plain versions and ranges alike. */
function parseVersion(raw: string): SemVer | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareVersions(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** True when `version` is at least `floor`. Both may be ranges; the first version wins. */
function satisfiesFloor(version: string, floor: string): boolean {
  const v = parseVersion(version);
  const f = parseVersion(floor);
  if (v === null || f === null) return false;
  return compareVersions(v, f) >= 0;
}

// ---------------------------------------------------------------------------
// npm plumbing
// ---------------------------------------------------------------------------

function npmView<T>(spec: string, field: string): T | null {
  try {
    const out = execFileSync('npm', ['view', spec, field, '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() === '' ? null : (JSON.parse(out) as T);
  } catch {
    return null;
  }
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
  workspaces?: string[];
  scripts?: Record<string, string>;
}

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as PackageJson;
}

interface Resolution {
  ok: boolean;
  /** Package name -> every version the resolver picked for it. */
  versions: Map<string, string[]>;
  error: string;
}

/**
 * Resolve a dependency set without downloading tarballs.
 *
 * `npm install --package-lock-only` builds the full tree from the registry and writes only
 * the lockfile, which is exactly what CI's `npm ci` would have to agree with. Running it in
 * a throwaway directory means we can ask "would this resolve?" without touching the repo.
 *
 * `mutate` receives a copy of the real package.json and may change it freely.
 */
function probeResolution(mutate: (pkg: PackageJson) => void): Resolution {
  const pkg = readPackageJson();

  // The probe directory is not a workspace root and must not run husky's `prepare`.
  delete pkg.workspaces;
  delete pkg.scripts;
  mutate(pkg);

  const dir = mkdtempSync(join(tmpdir(), 'dep-probe-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));

  try {
    execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--silent'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? String(error);
    return { ok: false, versions: new Map(), error: stderr.trim() };
  }

  const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { version?: string }>;
  };

  const versions = new Map<string, string[]>();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === '' || entry.version === undefined) continue;
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const seen = versions.get(name) ?? [];
    seen.push(entry.version);
    versions.set(name, seen);
  }

  return { ok: true, versions, error: '' };
}

// ---------------------------------------------------------------------------
// 1. Blockers
// ---------------------------------------------------------------------------

interface BlockerStatus {
  resolved: boolean;
  detail: string;
}

interface Blocker {
  id: string;
  title: string;
  waitingOn: string;
  /**
   * Package names (or `@scope/` prefixes) whose advisories this blocker accounts for.
   *
   * While the blocker holds, those packages CANNOT be overridden — pinning them would
   * break the very dependency doing the blocking. Their advisories are therefore reported
   * under the blocker rather than as "add an override", which would be actively bad advice.
   */
  owns: string[];
  /** What to do once it unblocks. Rendered as a checklist in the issue. */
  action: string[];
  check: () => BlockerStatus;
}

/**
 * Lower bound of a dependency range, as declared by an upstream package.
 *
 * `^3.23.8` -> 3.23.8, `>=4.8.4 <6.1.0` -> 4.8.4. Only the lower bound is read, because
 * these blockers are all "upstream has not moved up to major N yet" — an upper bound would
 * bring in range-arithmetic edge cases for no benefit.
 */
function declaredFloor(upstream: string, dependency: string): string | null {
  const deps = npmView<Record<string, string>>(upstream, 'dependencies');
  return deps?.[dependency] ?? null;
}

const blockers: Blocker[] = [
  {
    id: 'zod-v4',
    title: 'zod is pinned to 3.x by genkit',
    waitingOn: '`@genkit-ai/core` declaring a dependency on `zod@^4`',
    owns: ['zod', '@asteasolutions/zod-to-openapi'],
    action: [
      'Remove the `zod` and `@asteasolutions/zod-to-openapi` ignore rules from `.github/dependabot.yml`',
      'Migrate the schemas in `packages/shared-schemas/` to zod v4 (breaking changes: https://zod.dev/v4)',
      'Bump `@asteasolutions/zod-to-openapi` to v8, which requires zod v4',
    ],
    check(): BlockerStatus {
      const range = declaredFloor('@genkit-ai/core@latest', 'zod');
      if (range === null) {
        return { resolved: false, detail: 'could not read `@genkit-ai/core` dependencies' };
      }
      const floor = parseVersion(range);
      return {
        resolved: floor !== null && floor.major >= 4,
        detail: `\`@genkit-ai/core\` depends on \`zod@${range}\``,
      };
    },
  },
  {
    id: 'opentelemetry-2x',
    title: 'OpenTelemetry is pinned to the 0.5x line by genkit',
    waitingOn:
      '`@genkit-ai/core` declaring a dependency on `@opentelemetry/sdk-node@^0.200` or newer',
    owns: ['@opentelemetry/'],
    action: [
      'Remove the `@opentelemetry/exporter-trace-otlp-http` and `@opentelemetry/sdk-trace-node` ignore rules from `.github/dependabot.yml`',
      'Bump both packages and drop any now-redundant OpenTelemetry entries from `overrides`',
      'This is the single biggest advisory cluster in the tree — expect the audit count to fall sharply',
    ],
    check(): BlockerStatus {
      const range = declaredFloor('@genkit-ai/core@latest', '@opentelemetry/sdk-node');
      if (range === null) {
        return { resolved: false, detail: 'could not read `@genkit-ai/core` dependencies' };
      }
      const floor = parseVersion(range);
      const moved = floor !== null && (floor.major >= 1 || floor.minor >= 200);
      return {
        resolved: moved,
        detail: `\`@genkit-ai/core\` depends on \`@opentelemetry/sdk-node@${range}\``,
      };
    },
  },
  {
    id: 'typescript-7',
    title: 'TypeScript 7 is rejected by the @typescript-eslint peer range',
    waitingOn: '`@typescript-eslint` widening `peerDependencies.typescript` past 7',
    owns: ['typescript'],
    action: [
      'Remove the `typescript` ignore rule from `.github/dependabot.yml`',
      'Let Dependabot reopen the TypeScript 7 bump, or bump it by hand',
    ],
    check(): BlockerStatus {
      // Empirical, not range arithmetic: ask npm to resolve the real dependency set with
      // TypeScript pinned to 7. This is precisely the ERESOLVE that broke PR #166.
      const probe = probeResolution((pkg) => {
        if (pkg.devDependencies !== undefined) pkg.devDependencies['typescript'] = '^7';
      });
      const peers = npmView<Record<string, string>>(
        '@typescript-eslint/eslint-plugin@latest',
        'peerDependencies'
      );
      const declared = peers?.['typescript'] ?? 'unknown';
      return {
        resolved: probe.ok,
        detail: probe.ok
          ? 'the dependency set resolves with `typescript@^7`'
          : `\`@typescript-eslint/eslint-plugin\` declares \`peer typescript@"${declared}"\``,
      };
    },
  },
  {
    id: 'extract-zip',
    title: 'extract-zip has an unpatched advisory',
    waitingOn: 'a release of `extract-zip` newer than 2.0.1',
    owns: ['extract-zip'],
    action: [
      'Add an `extract-zip` entry to `overrides` in `package.json` pinning the patched release',
      'It is a dev-only dependency of `genkit-cli`, so this is low urgency until then',
    ],
    check(): BlockerStatus {
      const latest = npmView<string>('extract-zip', 'version');
      if (latest === null)
        return { resolved: false, detail: 'could not read `extract-zip` from npm' };
      return {
        resolved: !satisfiesFloor('2.0.1', latest),
        detail: `latest published \`extract-zip\` is ${latest}`,
      };
    },
  },
];

/**
 * Package name an override key targets. `uuid@11` -> `uuid`, `@hono/node-server` -> itself.
 * A leading `@` is an npm scope, not a version selector, hence `lastIndexOf` with `> 0`.
 */
function overrideTarget(key: string): string {
  const separator = key.lastIndexOf('@');
  return separator > 0 ? key.slice(0, separator) : key;
}

// ---------------------------------------------------------------------------
// 2. Dead overrides
// ---------------------------------------------------------------------------

/**
 * An override that names a package no longer present in the tree does nothing at all, and
 * can be deleted.
 *
 * Note what this deliberately does NOT report: overrides whose package currently resolves
 * above the pinned floor anyway. Those are not dead weight, they are insurance — the pin is
 * what guarantees the tree stays patched when some future `npm install` reshuffles it.
 * "Tidying" them away silently reopens the vulnerability.
 */
function findDeadOverrides(overrides: Record<string, string>): string[] {
  const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, unknown>;
  };

  const present = new Set<string>();
  for (const path of Object.keys(lock.packages)) {
    const marker = path.lastIndexOf('node_modules/');
    if (marker !== -1) present.add(path.slice(marker + 'node_modules/'.length));
  }

  return Object.keys(overrides).filter((key) => !present.has(overrideTarget(key)));
}

// ---------------------------------------------------------------------------
// 3. Advisories no override covers
// ---------------------------------------------------------------------------

interface UncoveredAdvisory {
  name: string;
  severity: string;
  scope: string;
  patched: string;
  summary: string;
}

interface DependabotAlert {
  state: string;
  dependency: { package: { name: string }; scope: string | null };
  security_advisory: { severity: string; summary: string };
  security_vulnerability: { first_patched_version: { identifier: string } | null };
}

interface AdvisoryScan {
  /** Advisories an override could and should fix. */
  uncovered: UncoveredAdvisory[];
  /** Advisories owned by a blocker that is still holding. Cannot be overridden today. */
  suppressed: Map<string, number>;
}

/**
 * Ask GitHub which advisories are still open, then subtract two groups:
 *
 *   - those an override already covers, and
 *   - those owned by a blocker that is still holding.
 *
 * The second subtraction is the important one. While genkit pins OpenTelemetry to `^0.52`,
 * "just add an `@opentelemetry/*` override" would break genkit outright. Recommending it
 * would be worse than saying nothing, so those advisories are counted under their blocker.
 *
 * Returns null when the token cannot read Dependabot alerts, so the report can say so
 * instead of quietly claiming everything is clean.
 */
async function scanAdvisories(
  overrides: Record<string, string>,
  holding: Blocker[]
): Promise<AdvisoryScan | null> {
  const token = process.env['GITHUB_TOKEN'];
  const repository = process.env['GITHUB_REPOSITORY'];
  if (token === undefined || repository === undefined) return null;

  const response = await fetch(
    `https://api.github.com/repos/${repository}/dependabot/alerts?state=open&per_page=100`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );
  if (!response.ok) return null;

  const alerts = (await response.json()) as DependabotAlert[];

  // An override covers a package when it pins at or above the patched version.
  const covers = (name: string, patched: string): boolean =>
    Object.entries(overrides).some(
      ([key, pinned]) => overrideTarget(key) === name && satisfiesFloor(pinned, patched)
    );

  // A blocker owns a package by exact name or by `@scope/` prefix.
  const ownedBy = (name: string): Blocker | undefined =>
    holding.find((blocker) =>
      blocker.owns.some((owned) => (owned.endsWith('/') ? name.startsWith(owned) : name === owned))
    );

  const uncovered = new Map<string, UncoveredAdvisory>();
  const suppressed = new Map<string, number>();

  for (const alert of alerts) {
    const patched = alert.security_vulnerability.first_patched_version?.identifier;
    const name = alert.dependency.package.name;
    if (patched === undefined || covers(name, patched)) continue;

    const owner = ownedBy(name);
    if (owner !== undefined) {
      suppressed.set(owner.id, (suppressed.get(owner.id) ?? 0) + 1);
      continue;
    }

    // Keep the highest patched floor per package so the suggested override is sufficient.
    const existing = uncovered.get(name);
    if (existing !== undefined && satisfiesFloor(existing.patched, patched)) continue;

    uncovered.set(name, {
      name,
      severity: alert.security_advisory.severity,
      scope: alert.dependency.scope ?? 'unknown',
      patched,
      summary: alert.security_advisory.summary,
    });
  }

  const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, moderate: 2, low: 3 };
  const sorted = [...uncovered.values()].sort(
    (a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) || a.name.localeCompare(b.name)
  );

  return { uncovered: sorted, suppressed };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const pkg = readPackageJson();
  const overrides = pkg.overrides ?? {};

  console.error('Checking upstream blockers…');
  const statuses = blockers.map((blocker) => ({ blocker, status: blocker.check() }));
  const unblocked = statuses.filter(({ status }) => status.resolved);
  const holding = statuses.filter(({ status }) => !status.resolved);

  console.error('Checking for dead overrides…');
  const dead = findDeadOverrides(overrides);

  console.error('Checking advisories…');
  const advisories = await scanAdvisories(
    overrides,
    holding.map(({ blocker }) => blocker)
  );

  const actionable =
    unblocked.length > 0 || dead.length > 0 || (advisories?.uncovered.length ?? 0) > 0;

  const lines: string[] = [];

  lines.push('## Dependency blockers & security status', '');
  lines.push(
    actionable
      ? 'Something here needs a human. Sections are ordered by urgency.'
      : 'Nothing to do. Every blocker is still real, every override still points at something ' +
          'in the tree, and every advisory is either covered or waiting on a blocker below.',
    ''
  );

  if (unblocked.length > 0) {
    lines.push('### ✅ Unblocked — action required', '');
    for (const { blocker, status } of unblocked) {
      lines.push(`#### ${blocker.title}`, '', `${status.detail}.`, '');
      for (const step of blocker.action) lines.push(`- [ ] ${step}`);
      lines.push('');
    }
  }

  if (advisories === null) {
    lines.push('### 🔒 Advisories', '');
    lines.push(
      'Skipped — the available token cannot read Dependabot alerts. Grant the workflow ' +
        '`security-events: read`, or run `npm audit` by hand.',
      ''
    );
  } else if (advisories.uncovered.length > 0) {
    lines.push('### 🔒 Advisories an override would fix', '');
    lines.push(
      'These are not blocked by anything. Add them to `overrides` in `package.json`, ' +
        'keeping each pin inside the major already in the tree:',
      ''
    );
    lines.push('| package | severity | scope | pin to |', '|---|---|---|---|');
    for (const advisory of advisories.uncovered) {
      lines.push(
        `| \`${advisory.name}\` | ${advisory.severity} | ${advisory.scope} | \`^${advisory.patched}\` |`
      );
    }
    lines.push('', 'Then:', '');
    lines.push('```sh', 'npm install', 'npm run check:lockfile', 'npm run test:run', '```', '');
  }

  if (dead.length > 0) {
    lines.push('### 🧹 Overrides pointing at nothing', '');
    lines.push(
      'These packages are no longer anywhere in the tree, so the override has no effect ' +
        'and can be deleted:',
      ''
    );
    for (const key of dead) lines.push(`- \`${key}\``);
    lines.push('');
  }

  if (holding.length > 0) {
    lines.push('### ⏳ Still blocked', '');
    lines.push('Nothing to do here — this section exists so the reasons stay visible.', '');
    for (const { blocker, status } of holding) {
      const count = advisories?.suppressed.get(blocker.id) ?? 0;
      const advisoryNote =
        count > 0 ? ` Currently accounts for ${count} advisor${count === 1 ? 'y' : 'ies'}.` : '';
      lines.push(
        `- **${blocker.title}** — waiting on ${blocker.waitingOn}. ${status.detail}.${advisoryNote}`
      );
    }
    lines.push('');
  }

  lines.push('---', '');
  lines.push(
    '<sub>Updated automatically by `.github/workflows/check-dependency-blockers.yml`. ' +
      'Run it locally with `npm run check:blockers`.</sub>'
  );

  const report = lines.join('\n');
  console.log(report);

  const output = process.env['GITHUB_OUTPUT'];
  if (output !== undefined) {
    const reportFile = join(process.env['RUNNER_TEMP'] ?? tmpdir(), 'dependency-report.md');
    writeFileSync(reportFile, report);
    appendFileSync(output, `actionable=${String(actionable)}\n`);
    appendFileSync(output, `report_file=${reportFile}\n`);
  }
}

await main();
