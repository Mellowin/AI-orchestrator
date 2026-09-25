/**
 * Deterministic local tooling resolution for repair checks.
 *
 * The Stage 18.26g ENOENT recurrence showed that resolving bare `npm`/`npx`
 * through PATH (even via cross-spawn) is not reliable in the real Windows
 * canonical launcher. Repair checks therefore never depend on PATH:
 *
 *   - npm scripts run as: process.execPath <absolute npm CLI> run <script>
 *     where the npm CLI is resolved from process.env.npm_execpath (trusted,
 *     set by the npm invocation that started the orchestrator) with a
 *     deterministic global-install fallback next to process.execPath.
 *   - targeted tsx tests run as: process.execPath <absolute tsx CLI> --test ...
 *     where the tsx CLI is the repository's own node_modules/tsx/dist/cli.mjs
 *     (falling back to the orchestrator's bundled tsx for tests).
 *
 * No shell is involved anywhere; arguments stay structured.
 */

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ToolingResolution {
  command: string;
  args: string[];
  /** Precise, non-empty failure reason when the tool cannot be resolved. */
  error: string | null;
}

export interface ToolingResolverOptions {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  existsFn?: (path: string) => boolean;
}

function defaultExists(path: string): boolean {
  return existsSync(path);
}

function isJsFile(path: string): boolean {
  return /\.(?:js|mjs|cjs)$/i.test(path);
}

/**
 * Resolve the absolute npm CLI entry script.
 *
 * Order (deterministic):
 *   1. process.env.npm_execpath when it is an absolute path to an existing JS file.
 *   2. <repoPath>/node_modules/npm/bin/npm-cli.js
 *   3. <dirname(process.execPath)>/node_modules/npm/bin/npm-cli.js (global install)
 */
export function resolveNpmCliJs(
  repoPath: string,
  options: ToolingResolverOptions = {}
): { path: string | null; error: string | null } {
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  const exists = options.existsFn ?? defaultExists;

  const execPathValid = typeof execPath === 'string' && execPath.length > 0 && isAbsolute(execPath);

  const npmExecPath = env.npm_execpath;
  if (
    typeof npmExecPath === 'string' &&
    npmExecPath.length > 0 &&
    isAbsolute(npmExecPath) &&
    isJsFile(npmExecPath) &&
    exists(npmExecPath)
  ) {
    return { path: npmExecPath, error: null };
  }

  const localCandidate = join(repoPath, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (exists(localCandidate)) {
    return { path: localCandidate, error: null };
  }

  if (execPathValid) {
    const globalCandidate = join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (exists(globalCandidate)) {
      return { path: globalCandidate, error: null };
    }
  }

  return {
    path: null,
    error:
      'npm CLI not found: npm_execpath is missing/invalid and no npm-cli.js exists next to ' +
      `process.execPath${execPathValid ? ` (${execPath})` : ' (process.execPath is not absolute)'}` +
      ' or in the repository node_modules. Refusing to fall back to bare `npm` (PATH-dependent).',
  };
}

/**
 * Resolve an `npm run <script>` invocation to an absolute, PATH-independent
 * command line: [process.execPath, <npm CLI>, 'run', <script>].
 */
export function resolveNpmRun(
  repoPath: string,
  script: string,
  options: ToolingResolverOptions = {}
): ToolingResolution {
  const execPath = options.execPath ?? process.execPath;
  const npm = resolveNpmCliJs(repoPath, options);
  if (npm.error !== null || npm.path === null) {
    return { command: execPath, args: [], error: npm.error ?? 'npm CLI not found' };
  }
  return { command: execPath, args: [npm.path, 'run', script], error: null };
}

/**
 * Resolve the repository's local tsx CLI
 * (<repoPath>/node_modules/tsx/dist/cli.mjs), falling back to the tsx bundled
 * with the orchestrator installation (for tests that use a fixture repo).
 */
export function resolveTsxCli(
  repoPath: string,
  options: ToolingResolverOptions = {}
): { path: string | null; error: string | null } {
  const exists = options.existsFn ?? defaultExists;

  const localCandidate = join(repoPath, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (exists(localCandidate)) {
    return { path: localCandidate, error: null };
  }

  // import.meta.url -> src/autopilot-run/tooling-resolution.ts -> repo root
  const orchestratorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const bundledCandidate = join(orchestratorRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (exists(bundledCandidate)) {
    return { path: bundledCandidate, error: null };
  }

  return {
    path: null,
    error:
      'tsx CLI not found: neither <repo>/node_modules/tsx/dist/cli.mjs nor the orchestrator ' +
      'bundled tsx exists. Refusing to fall back to bare `npx` (PATH-dependent).',
  };
}

/**
 * Resolve a targeted test run: [process.execPath, <tsx CLI>, '--test', <file>].
 */
export function resolveTsxTest(
  repoPath: string,
  testFile: string,
  options: ToolingResolverOptions = {}
): ToolingResolution {
  const execPath = options.execPath ?? process.execPath;
  const tsx = resolveTsxCli(repoPath, options);
  if (tsx.error !== null || tsx.path === null) {
    return { command: execPath, args: [], error: tsx.error ?? 'tsx CLI not found' };
  }
  return { command: execPath, args: [tsx.path, '--test', testFile], error: null };
}
