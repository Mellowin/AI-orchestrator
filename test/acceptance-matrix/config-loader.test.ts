import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadAcceptanceMatrixConfig,
  validateAcceptanceMatrixConfig,
} from '../../src/acceptance-matrix/config-loader.js';
import type { AcceptanceMatrixConfig } from '../../src/acceptance-matrix/types.js';

let counter = 0;

function createTempConfigFile(content: unknown): { path: string; cleanup: () => void } {
  const id = `${Date.now()}-${counter++}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `am-cfg-${id}-`));
  const path = join(tmpDir, 'config.json');
  writeFileSync(path, JSON.stringify(content), 'utf-8');
  return {
    path,
    cleanup: () => {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function validConfig(): AcceptanceMatrixConfig {
  return {
    provider: 'fake',
    allow_real_provider: false,
    allow_github_pr_create: false,
    allow_real_repo_apply: true,
    allow_real_repo_commit: true,
    allow_real_repo_push: true,
    stop_on_orchestrator_bug: true,
    report_dir: 'tmp/reports',
    sandbox_repo_path: 'tmp/sandbox',
    sandbox_repo_slug: 'owner/repo',
    scenarios: [
      {
        type: 'golden_real_multitask',
        label: 'Golden',
        base_branch: 'main',
        work_branch: 'am-golden',
        unsafe_response_mode: 'none',
      },
    ],
  };
}

describe('acceptance-matrix config-loader', () => {
  test('validates a correct config', () => {
    const result = validateAcceptanceMatrixConfig(validConfig());
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.reasons, []);
  });

  test('loads and resolves config paths', () => {
    const { path, cleanup } = createTempConfigFile(validConfig());
    try {
      const config = loadAcceptanceMatrixConfig(path);
      assert.strictEqual(config.provider, 'fake');
      assert.ok(config.report_dir.startsWith(process.cwd()));
      assert.ok(config.sandbox_repo_path.startsWith(process.cwd()));
    } finally {
      cleanup();
    }
  });

  test('rejects invalid provider', () => {
    const cfg = validConfig();
    cfg.provider = 'openai' as 'fake';
    const result = validateAcceptanceMatrixConfig(cfg);
    assert.strictEqual(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes('provider')));
  });

  test('rejects empty scenarios', () => {
    const cfg = validConfig();
    cfg.scenarios = [];
    const result = validateAcceptanceMatrixConfig(cfg);
    assert.strictEqual(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes('scenarios')));
  });

  test('rejects missing base_branch', () => {
    const cfg = validConfig();
    (cfg.scenarios[0] as Record<string, unknown>).base_branch = '';
    const result = validateAcceptanceMatrixConfig(cfg);
    assert.strictEqual(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes('base_branch')));
  });

  test('rejects invalid unsafe_response_mode', () => {
    const cfg = validConfig();
    cfg.scenarios[0].unsafe_response_mode = 'random' as 'none';
    const result = validateAcceptanceMatrixConfig(cfg);
    assert.strictEqual(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes('unsafe_response_mode')));
  });

  test('rejects non-object env values', () => {
    const cfg = validConfig();
    (cfg.scenarios[0] as Record<string, unknown>).env = 'not-an-object';
    const result = validateAcceptanceMatrixConfig(cfg);
    assert.strictEqual(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes('env')));
  });

  test('throws on malformed JSON file', () => {
    const id = `${Date.now()}-${counter++}`;
    const tmpBase = join(process.cwd(), 'tmp');
    if (!existsSync(tmpBase)) {
      mkdirSync(tmpBase);
    }
    const tmpDir = mkdtempSync(join(tmpBase, `am-cfg-bad-${id}-`));
    const path = join(tmpDir, 'config.json');
    writeFileSync(path, '{ not valid json', 'utf-8');
    try {
      assert.throws(() => loadAcceptanceMatrixConfig(path), /valid JSON/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
