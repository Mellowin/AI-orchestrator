import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadAutopilotRunConfig,
  validateAutopilotRunConfig,
} from '../src/autopilot-run/index.js';
import type { AutopilotRunConfig } from '../src/autopilot-run/types.js';

let counter = 0;

function tmpConfigFile(content: unknown): { path: string; cleanup: () => void } {
  const id = `${Date.now()}-${counter++}`;
  const base = join(process.cwd(), 'tmp');
  if (!existsSync(base)) {
    mkdirSync(base);
  }
  const dir = mkdtempSync(join(base, `autopilot-config-${id}-`));
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
    base_branch: 'main',
    work_branch: 'autopilot-test',
    mvp_config_path: 'configs/mvp-run.example.json',
    diagnose_config: {
      token_env: 'GITHUB_TOKEN',
      include_raw_logs: false,
      max_log_excerpt_chars: 4000,
    },
    ci: {
      enabled: false,
      wait_for_ci: false,
      poll_interval_seconds: 15,
      timeout_seconds: 900,
    },
    repair: {
      enabled: false,
      max_attempts: 2,
      provider: 'mock',
      allow_real_provider: false,
      allow_apply: false,
      allow_commit: false,
      allow_push: false,
      allowed_files: ['src/**/*.ts'],
      denied_files: ['.env*'],
    },
    github: {
      allow_pr_create: false,
      allow_pr_update: false,
      allow_actions_read: false,
      allow_write: false,
    },
    report_dir: 'reports/autopilot',
  };
}

describe('autopilot-run config-loader', () => {
  test('fake config validates and applies defaults', () => {
    const { path, cleanup } = tmpConfigFile(validConfig());
    try {
      const config = loadAutopilotRunConfig(path);
      assert.strictEqual(config.mode, 'fake');
      assert.strictEqual(config.run_id, 'test-run');
      assert.strictEqual(config.repo_slug, 'owner/repo');
      assert.strictEqual(config.diagnose_config.token_env, 'GITHUB_TOKEN');
      assert.strictEqual(config.ci.enabled, false);
      assert.strictEqual(config.ci.poll_interval_seconds, 15);
      assert.strictEqual(config.repair.max_attempts, 2);
      assert.strictEqual(config.repair.provider, 'mock');
      assert.deepStrictEqual(config.repair.denied_files, ['.env*']);
      assert.strictEqual(config.github.allow_pr_create, false);
      assert.ok(config.report_dir.startsWith(process.cwd()));
    } finally {
      cleanup();
    }
  });

  test('rejects missing config file with clean error', () => {
    assert.throws(() => loadAutopilotRunConfig('nonexistent/path/config.json'), /not found|unreadable/i);
  });

  test('rejects invalid mode', () => {
    const c = validConfig();
    c.mode = 'gitlab';
    const { path, cleanup } = tmpConfigFile(c);
    try {
      assert.throws(() => loadAutopilotRunConfig(path), /mode/);
    } finally {
      cleanup();
    }
  });

  test('rejects invalid repo_slug', () => {
    const c = validConfig();
    c.repo_slug = 'invalid';
    const { path, cleanup } = tmpConfigFile(c);
    try {
      assert.throws(() => loadAutopilotRunConfig(path), /repo_slug/);
    } finally {
      cleanup();
    }
  });

  test('rejects missing mvp_config_path', () => {
    const c = validConfig();
    delete (c as Record<string, unknown>).mvp_config_path;
    const { path, cleanup } = tmpConfigFile(c);
    try {
      assert.throws(() => loadAutopilotRunConfig(path), /mvp_config_path/);
    } finally {
      cleanup();
    }
  });

  test('rejects negative max_log_excerpt_chars', () => {
    const c = validConfig();
    (c.diagnose_config as Record<string, unknown>).max_log_excerpt_chars = -1;
    const { path, cleanup } = tmpConfigFile(c);
    try {
      assert.throws(() => loadAutopilotRunConfig(path), /max_log_excerpt_chars/);
    } finally {
      cleanup();
    }
  });

  test('rejects non-integer repair max_attempts', () => {
    const c = validConfig();
    (c.repair as Record<string, unknown>).max_attempts = 1.5;
    const { path, cleanup } = tmpConfigFile(c);
    try {
      assert.throws(() => loadAutopilotRunConfig(path), /max_attempts/);
    } finally {
      cleanup();
    }
  });
});
