import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function resolveBackupPath(runDir: string, date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const timestamp = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
  let candidate = join(runDir, `ai-output.backup-${timestamp}.json`);
  if (!existsSync(candidate)) {
    return candidate;
  }
  let counter = 1;
  while (true) {
    candidate = join(runDir, `ai-output.backup-${timestamp}-${counter}.json`);
    if (!existsSync(candidate)) {
      return candidate;
    }
    counter++;
  }
}
