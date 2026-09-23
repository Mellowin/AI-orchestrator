import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildEphemeralGitAuthEnv,
  getGitRemoteUrl,
  injectGitHubTokenIntoRemoteUrl,
  stripCredentialsFromRemoteUrl,
} from '../src/git-push-auth.js';

describe('git-push-auth', () => {
  test('injectGitHubTokenIntoRemoteUrl injects fine-grained PAT as password with x-access-token username', () => {
    const url = 'https://github.com/Mellowin/AI-orchestrator.git';
    const token = 'github_pat_123abc';
    const result = injectGitHubTokenIntoRemoteUrl(url, token);
    assert.strictEqual(
      result,
      'https://x-access-token:github_pat_123abc@github.com/Mellowin/AI-orchestrator.git'
    );
  });

  test('injectGitHubTokenIntoRemoteUrl injects classic PAT as password with x-access-token username', () => {
    const url = 'https://github.com/Mellowin/AI-orchestrator.git';
    const token = 'ghp_123abc';
    const result = injectGitHubTokenIntoRemoteUrl(url, token);
    assert.strictEqual(
      result,
      'https://x-access-token:ghp_123abc@github.com/Mellowin/AI-orchestrator.git'
    );
  });

  test('injectGitHubTokenIntoRemoteUrl uses x-access-token scheme for GitHub App installation tokens', () => {
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

  test('stripCredentialsFromRemoteUrl removes embedded userinfo', () => {
    assert.strictEqual(
      stripCredentialsFromRemoteUrl('https://x-access-token:ghp_secret@github.com/owner/repo.git'),
      'https://github.com/owner/repo.git'
    );
    assert.strictEqual(
      stripCredentialsFromRemoteUrl('https://user:pass@github.com/owner/repo.git'),
      'https://github.com/owner/repo.git'
    );
  });

  test('stripCredentialsFromRemoteUrl keeps clean URLs and non-URL inputs unchanged', () => {
    assert.strictEqual(
      stripCredentialsFromRemoteUrl('https://github.com/owner/repo.git'),
      'https://github.com/owner/repo.git'
    );
    assert.strictEqual(
      stripCredentialsFromRemoteUrl('git@github.com:owner/repo.git'),
      'git@github.com:owner/repo.git'
    );
    assert.strictEqual(stripCredentialsFromRemoteUrl('/tmp/local/remote.git'), '/tmp/local/remote.git');
  });

  test('buildEphemeralGitAuthEnv carries a github-scoped Authorization header via GIT_CONFIG env', () => {
    const env = buildEphemeralGitAuthEnv('ghp_sentinel_ephemeral');
    assert.strictEqual(env.GIT_CONFIG_COUNT, '1');
    assert.strictEqual(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraHeader');
    assert.strictEqual(env.GIT_CONFIG_VALUE_0, 'Authorization: Bearer ghp_sentinel_ephemeral');
  });

  test('buildEphemeralGitAuthEnv defaults to process.env.GITHUB_TOKEN and returns {} without a token', () => {
    const prev = process.env.GITHUB_TOKEN;
    try {
      process.env.GITHUB_TOKEN = 'ghp_from_env';
      assert.strictEqual(
        buildEphemeralGitAuthEnv().GIT_CONFIG_VALUE_0,
        'Authorization: Bearer ghp_from_env'
      );
      delete process.env.GITHUB_TOKEN;
      assert.deepStrictEqual(buildEphemeralGitAuthEnv(), {});
    } finally {
      if (prev === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = prev;
      }
    }
  });
});
