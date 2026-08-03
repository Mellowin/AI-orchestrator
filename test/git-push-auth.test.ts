import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  getGitRemoteUrl,
  injectGitHubTokenIntoRemoteUrl,
} from '../src/git-push-auth.js';

describe('git-push-auth', () => {
  test('injectGitHubTokenIntoRemoteUrl injects fine-grained PAT as username', () => {
    const url = 'https://github.com/Mellowin/AI-orchestrator.git';
    const token = 'github_pat_123abc';
    const result = injectGitHubTokenIntoRemoteUrl(url, token);
    assert.strictEqual(result, 'https://github_pat_123abc@github.com/Mellowin/AI-orchestrator.git');
  });

  test('injectGitHubTokenIntoRemoteUrl injects classic PAT as username', () => {
    const url = 'https://github.com/Mellowin/AI-orchestrator.git';
    const token = 'ghp_123abc';
    const result = injectGitHubTokenIntoRemoteUrl(url, token);
    assert.strictEqual(result, 'https://ghp_123abc@github.com/Mellowin/AI-orchestrator.git');
  });

  test('injectGitHubTokenIntoRemoteUrl uses x-access-token scheme for non-PAT tokens', () => {
    const url = 'https://github.com/Mellowin/AI-orchestrator.git';
    const token = 'installation_token_123';
    const result = injectGitHubTokenIntoRemoteUrl(url, token);
    assert.strictEqual(result, 'https://x-access-token:installation_token_123@github.com/Mellowin/AI-orchestrator.git');
  });

  test('injectGitHubTokenIntoRemoteUrl returns null for non-GitHub host', () => {
    const url = 'https://gitlab.com/foo/bar.git';
    const result = injectGitHubTokenIntoRemoteUrl(url, 'token');
    assert.strictEqual(result, null);
  });

  test('injectGitHubTokenIntoRemoteUrl returns null for SSH URL', () => {
    const url = 'git@github.com:Mellowin/AI-orchestrator.git';
    const result = injectGitHubTokenIntoRemoteUrl(url, 'token');
    assert.strictEqual(result, null);
  });

  test('injectGitHubTokenIntoRemoteUrl URL-encodes special token characters', () => {
    const url = 'https://github.com/Mellowin/AI-orchestrator.git';
    const token = 'abc@def:ghi';
    const result = injectGitHubTokenIntoRemoteUrl(url, token);
    assert.ok(result);
    assert.ok(result!.includes(encodeURIComponent(token)), 'token should be URL-encoded in result');
    assert.ok(!result!.includes('@def:'), 'raw special characters should not leak into URL host portion');
  });

  test('getGitRemoteUrl reads configured origin URL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-push-auth-test-'));
    spawnSync('git', ['init'], { cwd: dir, shell: false, encoding: 'utf-8' });
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/Mellowin/AI-orchestrator.git'], {
      cwd: dir,
      shell: false,
      encoding: 'utf-8',
    });
    const url = getGitRemoteUrl(dir, 'origin');
    assert.strictEqual(url, 'https://github.com/Mellowin/AI-orchestrator.git');
  });

  test('getGitRemoteUrl returns null when remote does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-push-auth-test-'));
    spawnSync('git', ['init'], { cwd: dir, shell: false, encoding: 'utf-8' });
    const url = getGitRemoteUrl(dir, 'origin');
    assert.strictEqual(url, null);
  });
});
