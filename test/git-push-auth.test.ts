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

  test('buildEphemeralGitAuthEnv carries a github-scoped HTTP Basic PAT header via GIT_CONFIG env', () => {
    const env = buildEphemeralGitAuthEnv('ghp_sentinel_ephemeral');
    assert.strictEqual(env.GIT_CONFIG_COUNT, '1');
    assert.strictEqual(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraHeader');
    const expectedBasic = Buffer.from('x-access-token:ghp_sentinel_ephemeral', 'utf-8').toString('base64');
    assert.strictEqual(env.GIT_CONFIG_VALUE_0, `Authorization: Basic ${expectedBasic}`);
    assert.ok(!env.GIT_CONFIG_VALUE_0.includes('Bearer'), 'Git smart-HTTP PAT auth must not use Bearer');
    assert.ok(
      !env.GIT_CONFIG_VALUE_0.includes('ghp_sentinel_ephemeral'),
      'raw token must not appear in the header value'
    );
  });

  test('buildEphemeralGitAuthEnv decodes to a non-empty username with the PAT as password', () => {
    const token = 'github_pat_SENTINELdecode000000000000';
    const env = buildEphemeralGitAuthEnv(token);
    const match = env.GIT_CONFIG_VALUE_0.match(/^Authorization: Basic (.+)$/);
    assert.ok(match, 'header must use the Basic scheme');
    const decoded = Buffer.from(match[1], 'base64').toString('utf-8');
    const sep = decoded.indexOf(':');
    assert.ok(sep > 0, 'username must be non-empty');
    assert.strictEqual(decoded.slice(0, sep), 'x-access-token');
    assert.strictEqual(decoded.slice(sep + 1), token, 'PAT must be the password credential');
  });

  test('buildEphemeralGitAuthEnv defaults to process.env.GITHUB_TOKEN and returns {} without a token', () => {
    const prev = process.env.GITHUB_TOKEN;
    try {
      process.env.GITHUB_TOKEN = 'ghp_from_env';
      const expectedBasic = Buffer.from('x-access-token:ghp_from_env', 'utf-8').toString('base64');
      assert.strictEqual(
        buildEphemeralGitAuthEnv().GIT_CONFIG_VALUE_0,
        `Authorization: Basic ${expectedBasic}`
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

  test('buildEphemeralGitAuthEnv reads the CURRENT environment (credential rotation on resume)', () => {
    const prev = process.env.GITHUB_TOKEN;
    try {
      process.env.GITHUB_TOKEN = 'ghp_rotated_old';
      const first = buildEphemeralGitAuthEnv();
      process.env.GITHUB_TOKEN = 'ghp_rotated_new';
      const second = buildEphemeralGitAuthEnv();
      const decode = (v: string) =>
        Buffer.from(v.replace('Authorization: Basic ', ''), 'base64').toString('utf-8');
      assert.strictEqual(decode(first.GIT_CONFIG_VALUE_0), 'x-access-token:ghp_rotated_old');
      assert.strictEqual(decode(second.GIT_CONFIG_VALUE_0), 'x-access-token:ghp_rotated_new');
      assert.notStrictEqual(first.GIT_CONFIG_VALUE_0, second.GIT_CONFIG_VALUE_0);
    } finally {
      if (prev === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = prev;
      }
    }
  });
});
