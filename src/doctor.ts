import { spawnSync } from 'node:child_process';

export interface DoctorReport {
  verdict: 'DOCTOR_READY_SAFE' | 'DOCTOR_READY_REAL_PR' | 'DOCTOR_READY_REAL_REPAIR' | 'DOCTOR_READY_WITH_CAVEATS' | 'DOCTOR_FAILED';
  nodeVersion: string;
  nodeOk: boolean;
  npmOk: boolean;
  gitOk: boolean;
  repoPath: string;
  isGitRepo: boolean;
  currentBranch: string | null;
  workingTreeClean: boolean;
  kimiKeyPresent: boolean;
  githubTokenPresent: boolean;
  safeReady: boolean;
  realPrReady: boolean;
  realRepairReady: boolean;
  caveats: string[];
}

function runCommand(cmd: string, args: string[], cwd?: string): { ok: boolean; output: string } {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf-8', shell: false });
  return {
    ok: result.status === 0,
    output: (result.stdout || '').trim(),
  };
}

function runNpmVersion(cwd?: string): { ok: boolean; output: string } {
  if (process.platform === 'win32') {
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/c', 'npm', '--version'], { cwd, encoding: 'utf-8', shell: false });
    return { ok: result.status === 0, output: (result.stdout || '').trim() };
  }
  return runCommand('npm', ['--version'], cwd);
}

function checkNodeVersion(): { ok: boolean; version: string } {
  const version = process.version;
  const major = Number(version.replace(/^v/, '').split('.')[0]);
  return { ok: major >= 20, version };
}

export function runDoctor(cwd: string = process.cwd()): DoctorReport {
  const caveats: string[] = [];

  const node = checkNodeVersion();
  const npm = runNpmVersion(cwd);
  const git = runCommand('git', ['--version'], cwd);

  const gitRepoCheck = runCommand('git', ['rev-parse', '--is-inside-work-tree'], cwd);
  const isGitRepo = gitRepoCheck.ok && gitRepoCheck.output === 'true';

  const branchResult = isGitRepo ? runCommand('git', ['branch', '--show-current'], cwd) : { ok: false, output: '' };
  const currentBranch = branchResult.ok && branchResult.output ? branchResult.output : null;

  const statusResult = isGitRepo ? runCommand('git', ['status', '--porcelain'], cwd) : { ok: false, output: '' };
  const workingTreeClean = statusResult.ok && statusResult.output.length === 0;

  const kimiKeyPresent = typeof process.env.KIMI_API_KEY === 'string' && process.env.KIMI_API_KEY.trim().length > 0;
  const githubTokenPresent = typeof process.env.GITHUB_TOKEN === 'string' && process.env.GITHUB_TOKEN.trim().length > 0;

  const basicOk = node.ok && npm.ok && git.ok && isGitRepo;
  const safeReady = basicOk;
  const realPrReady = basicOk && kimiKeyPresent && githubTokenPresent;
  const realRepairReady = realPrReady;

  if (!node.ok) caveats.push(`Node.js ${node.version} is below the required Node 20+`);
  if (!npm.ok) caveats.push('npm is not available');
  if (!git.ok) caveats.push('git is not available');
  if (!isGitRepo) caveats.push(`Directory ${cwd} is not a git repository`);
  if (isGitRepo && !workingTreeClean) caveats.push('Working tree has uncommitted changes');
  if (!kimiKeyPresent) caveats.push('KIMI_API_KEY is missing (real provider modes disabled)');
  if (!githubTokenPresent) caveats.push('GITHUB_TOKEN is missing (real PR/repair modes disabled)');

  let verdict: DoctorReport['verdict'];
  if (!basicOk) {
    verdict = 'DOCTOR_FAILED';
  } else if (realRepairReady) {
    verdict = 'DOCTOR_READY_REAL_REPAIR';
  } else if (realPrReady) {
    verdict = 'DOCTOR_READY_REAL_PR';
  } else if (caveats.length > 0) {
    verdict = 'DOCTOR_READY_WITH_CAVEATS';
  } else {
    verdict = 'DOCTOR_READY_SAFE';
  }

  return {
    verdict,
    nodeVersion: node.version,
    nodeOk: node.ok,
    npmOk: npm.ok,
    gitOk: git.ok,
    repoPath: cwd,
    isGitRepo,
    currentBranch,
    workingTreeClean,
    kimiKeyPresent,
    githubTokenPresent,
    safeReady,
    realPrReady,
    realRepairReady,
    caveats,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`[doctor] ${report.verdict}`);
  lines.push(`  Node.js: ${report.nodeVersion} ${report.nodeOk ? 'OK' : 'FAIL'}`);
  lines.push(`  npm: ${report.npmOk ? 'OK' : 'FAIL'}`);
  lines.push(`  git: ${report.gitOk ? 'OK' : 'FAIL'}`);
  lines.push(`  repo path: ${report.repoPath}`);
  lines.push(`  git repository: ${report.isGitRepo ? 'yes' : 'no'}`);
  if (report.currentBranch !== null) lines.push(`  current branch: ${report.currentBranch}`);
  lines.push(`  working tree: ${report.workingTreeClean ? 'clean' : 'dirty'}`);
  lines.push(`  KIMI_API_KEY: ${report.kimiKeyPresent ? 'present' : 'missing'}`);
  lines.push(`  GITHUB_TOKEN: ${report.githubTokenPresent ? 'present' : 'missing'}`);
  lines.push(`  safe mode: ${report.safeReady ? 'ready' : 'not ready'}`);
  lines.push(`  real-pr mode: ${report.realPrReady ? 'ready' : 'not ready'}`);
  lines.push(`  real-repair mode: ${report.realRepairReady ? 'ready' : 'not ready'}`);
  if (report.caveats.length > 0) {
    lines.push('  caveats:');
    for (const c of report.caveats) lines.push(`    - ${c}`);
  }
  return lines.join('\n');
}
