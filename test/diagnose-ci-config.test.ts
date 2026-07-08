import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadDiagnoseCiConfig,
  validateDiagnoseCiConfig,
} from '../src/diagnose-ci/config-loader.js';

let counter = 0;

function tmpConfigFile(content: unknown): { path: string; cleanup: () => void } {
  const id = `${Date.now()}-${counter++}`;
  const base = join(process.cwd(), 'tmp');
  if (!existsSync(base)) {
    mkdirSync(base);
  }
  const dir = mkdtempSync(join(base, `diagnose-ci-config-${id}-`));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(content), 'utf-8');
  return {
    path,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function validConfig(): Record<string, unknown> {
  return {
    mode: 'fake',
    run_id: 'test-run',
    repo_slug: 'owner/repo',
    target: { workflow_run_id: 123 },
    token_env: 'GITHUB_TOKEN',
    report_dir: 'tmp/diagnose-ci-reports',
    include_raw_logs: false,
    max_log_excerpt_chars: 4000,
    allow_github_write: false,
  };
}

describe('diagnose-ci config-loader', () => {
  test('loads fake config and applies defaults', () => {
    const { path, cleanup } = tmpConfigFile(validConfig());
    try {
      const config = loadDiagnoseCiConfig(path);
      assert.strictEqual(config.mode, 'fake');
      assert.strictEqual(config.run_id, 'test-run');
      assert.strictEqual(config.repo_slug, 'owner/repo');
      assert.strictEqual(config.token_env, 'GITHUB_TOKEN');
      assert.strictEqual(config.include_raw_logs, false);
      assert.strictEqual(config.max_log_excerpt_chars, 4000);
      assert.strictEqual(config.allow_github_write, false);
      assert.strictEqual(config.fake_scenario, 'green');
      assert(config.report_dir.startsWith(process.cwd()));
    } finally {
      cleanup();
    }
  });

  test('rejects missing config file with clean error', () => {
    assert.throws(() => loadDiagnoseCiConfig('nonexistent/path/config.json'), /not found|unreadable/i);
  });

  test('rejects invalid mode', () => {
    const c = validConfig();
    c.mode = 'gitlab';
    const { path, cleanup } = tmpConfigFile(c);
    try {
      assert.throws(() => loadDiagnoseCiConfig(path), /mode/);
    } finally {
      cleanup();
    }
  });

  test('rejects missing target', () => {
    const c = validConfig();
    c.target = {};
    const { path, cleanup } = tmpConfigFile(c);
    try {
      assert.throws(() => loadDiagnoseCiConfig(path), /target/);
    } finally {
      cleanup();
    }
  });

  test('rejects allow_github_write true', () => {
    const c = validConfig();
    c.allow_github_write = true;
    const { path, cleanup } = tmpConfigFile(c);
    try {
      assert.throws(() => loadDiagnoseCiConfig(path), /allow_github_write/);
    } finally {
      cleanup();
    }
  });

  test('validates github mode config without token', () => {
    const c = validConfig();
    c.mode = 'github';
    const validation = validateDiagnoseCiConfig(c as Record<string, unknown>);
    assert.strictEqual(validation.ok, true, validation.reasons.join(', '));
  });
});
