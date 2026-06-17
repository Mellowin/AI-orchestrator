import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createDisposablePilotRepo } from './create-disposable-pilot-repo.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');
const exampleBlockPath = join(projectRoot, 'examples', 'disposable-pilot', 'block.json');

/**
 * Check whether all required opt-ins for a real disposable pilot run are set.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
export function hasRealRunOptIns(env) {
  return (
    (env.ALLOW_REAL_PROVIDER === 'true' || env.ALLOW_REAL_PROVIDER === '1') &&
    env.ALLOW_KIMI_REVIEWER === 'true' &&
    typeof env.KIMI_API_KEY === 'string' &&
    env.KIMI_API_KEY.length > 0 &&
    typeof env.KIMI_BASE_URL === 'string' &&
    env.KIMI_BASE_URL.length > 0 &&
    env.REAL_BLOCK_RUN_AI === '1' &&
    env.ALLOW_REAL_REPO_APPLY === 'true' &&
    env.ALLOW_REAL_REPO_COMMIT === 'true' &&
    env.ALLOW_REAL_REPO_PUSH === 'true'
  );
}

/**
 * Build a block JSON for the disposable repo by substituting the repo path
 * into the example template.
 *
 * @param {string} examplePath
 * @param {string} repoPath
 * @returns {string}
 */
export function buildBlockJson(examplePath, repoPath) {
  const template = JSON.parse(readFileSync(examplePath, 'utf-8'));
  template.repo_path = repoPath;
  return JSON.stringify(template, null, 2);
}

/**
 * Run the disposable pilot demo.
 *
 * Without real-provider opt-ins this only prepares the disposable repo and
 * prints the command to run. With opt-ins it also invokes the real pilot.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ ok: boolean; tempDir: string; repoPath: string; blockPath: string; command: string; ranRealPilot: boolean; exitCode: number; output: string }}
 */
export async function runDemo(env = process.env) {
  const { tempDir, repoPath, workBranch } = createDisposablePilotRepo();
  const blockPath = join(tempDir, 'block.json');
  writeFileSync(blockPath, buildBlockJson(exampleBlockPath, repoPath), 'utf-8');

  const command = `npx tsx "${join(projectRoot, 'src', 'cli.ts')}" real-block-disposable-pilot "${blockPath}" --provider kimi --timeout-ms 120000`;

  let output = '';
  let ranRealPilot = false;
  let exitCode = 0;

  if (hasRealRunOptIns(env)) {
    ranRealPilot = true;
    const result = spawnSync(
      'npx',
      [
        'tsx',
        join(projectRoot, 'src', 'cli.ts'),
        'real-block-disposable-pilot',
        blockPath,
        '--provider',
        'kimi',
        '--timeout-ms',
        '120000',
      ],
      {
        cwd: projectRoot,
        env: { ...env },
        encoding: 'utf-8',
        shell: false,
        timeout: 300000,
      }
    );
    exitCode = result.status ?? 1;
    output = (result.stdout || '') + (result.stderr || '');
    if (result.error) {
      output += `\nSpawn error: ${result.error.message}`;
    }
  } else {
    output = [
      'Disposable pilot demo prepared.',
      `Repo: ${repoPath}`,
      `Block: ${blockPath}`,
      `Work branch: ${workBranch}`,
      '',
      'To run with real Kimi, set all required opt-ins:',
      '  ALLOW_REAL_PROVIDER=true',
      '  ALLOW_KIMI_REVIEWER=true',
      '  KIMI_API_KEY=...',
      '  KIMI_BASE_URL=https://api.moonshot.cn/v1',
      '  REAL_BLOCK_RUN_AI=1',
      '  ALLOW_REAL_REPO_APPLY=true',
      '  ALLOW_REAL_REPO_COMMIT=true',
      '  ALLOW_REAL_REPO_PUSH=true',
      '',
      `Then run:\n  ${command}`,
    ].join('\n');
  }

  return { ok: true, tempDir, repoPath, blockPath, command, ranRealPilot, exitCode, output };
}

if (process.argv[1] === __filename) {
  runDemo()
    .then((result) => {
      console.log(result.output);
      process.exitCode = result.exitCode;
    })
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    });
}
