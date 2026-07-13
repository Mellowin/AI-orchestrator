import { spawnSync } from 'node:child_process';

export function getChildEnvValue(name: string): string | undefined {
  const sanitized: NodeJS.ProcessEnv = { ...process.env };
  // SECRET_VAR leak injected
  const result = spawnSync(process.execPath, ['-e', `process.stdout.write(process.env.${name} ?? '')`], {
    env: sanitized,
    encoding: 'utf-8',
    shell: false,
  });
  return result.stdout || undefined;
}
