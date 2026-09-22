import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyGitRemoteFailure,
  isGitCredentialFailureKind,
  sanitizeGitRemoteMessage,
} from '../src/git-remote-failure.js';
import type { GitRemoteFailureKind } from '../src/git-remote-failure.js';

const REMOTE = 'origin';

function classify(output: string, operation: 'push' | 'fetch' | 'ls-remote' | 'preflight_write_check' = 'push') {
  return classifyGitRemoteFailure({ remote: REMOTE, operation, output });
}

describe('classifyGitRemoteFailure — auth failures', () => {
  // Regression item 1: GitHub "Invalid username or token" push rejection.
  test('item 1: invalid username or token + authentication failed -> GIT_AUTH_INVALID, pause recommended', () => {
    const result = classify(
      "remote: Invalid username or token.\n" +
        'Password authentication is not supported for Git operations.\n' +
        "fatal: Authentication failed for 'https://github.com/Mellowin/AI-orchestrator.git/'",
      'push'
    );
    assert.equal(result.failure_kind, 'GIT_AUTH_INVALID');
    assert.equal(result.pause_recommended, true);
    assert.equal(result.http_status, null);
  });

  // Regression item 2: bare "Authentication failed" is a resumable pause.
  test('item 2: fatal: Authentication failed -> GIT_AUTH_INVALID, pause recommended', () => {
    const result = classify("fatal: Authentication failed for 'https://github.com/Mellowin/AI-orchestrator.git/'");
    assert.equal(result.failure_kind, 'GIT_AUTH_INVALID');
    assert.equal(result.pause_recommended, true);
  });

  // Regression item 3: "expired" in an auth message -> GIT_AUTH_EXPIRED.
  test('item 3: token expired message -> GIT_AUTH_EXPIRED, pause recommended', () => {
    const result = classify('remote: Invalid username or token. Token expired');
    assert.equal(result.failure_kind, 'GIT_AUTH_EXPIRED');
    assert.equal(result.pause_recommended, true);
  });

  // Regression item 4: HTTP 401 alone classifies as GIT_AUTH_INVALID.
  test('item 4: HTTP 401 without auth keywords -> GIT_AUTH_INVALID via http_status', () => {
    const result = classify("fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 401");
    assert.equal(result.failure_kind, 'GIT_AUTH_INVALID');
    assert.equal(result.http_status, 401);
    assert.equal(result.pause_recommended, true);
  });
});

describe('classifyGitRemoteFailure — permission failures', () => {
  // Regression item 5: permission-denied variants.
  test('item 5: "Permission to <repo> denied" -> GIT_PERMISSION_DENIED, pause recommended', () => {
    const result = classify('remote: Permission to Mellowin/AI-orchestrator.git denied to user.');
    assert.equal(result.failure_kind, 'GIT_PERMISSION_DENIED');
    assert.equal(result.pause_recommended, true);
  });

  test('item 5: "write access not granted" -> GIT_PERMISSION_DENIED, pause recommended', () => {
    const result = classify('remote: write access not granted for this repository');
    assert.equal(result.failure_kind, 'GIT_PERMISSION_DENIED');
    assert.equal(result.pause_recommended, true);
  });

  test('item 5: HTTP 403 without keywords -> GIT_PERMISSION_DENIED via http_status', () => {
    const result = classify("fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403");
    assert.equal(result.failure_kind, 'GIT_PERMISSION_DENIED');
    assert.equal(result.http_status, 403);
    assert.equal(result.pause_recommended, true);
  });
});

describe('classifyGitRemoteFailure — network failures', () => {
  // Regression item 6: network failures are distinct from auth but also pause.
  test('item 6: "Could not resolve host" -> GIT_NETWORK_FAILURE, pause recommended', () => {
    const result = classify(
      "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com"
    );
    assert.equal(result.failure_kind, 'GIT_NETWORK_FAILURE');
    assert.equal(result.pause_recommended, true);
  });

  test('item 6: "Failed to connect" -> GIT_NETWORK_FAILURE, pause recommended', () => {
    const result = classify('fatal: unable to connect to github.com:\nFailed to connect to github.com port 443');
    assert.equal(result.failure_kind, 'GIT_NETWORK_FAILURE');
    assert.equal(result.pause_recommended, true);
  });

  test('item 6: network is classified separately from auth (different kind, both pause)', () => {
    const network = classify("fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com");
    const auth = classify("fatal: Authentication failed for 'https://github.com/o/r.git/'");
    assert.notEqual(network.failure_kind, auth.failure_kind);
    assert.equal(network.failure_kind, 'GIT_NETWORK_FAILURE');
    assert.equal(auth.failure_kind, 'GIT_AUTH_INVALID');
    assert.equal(network.pause_recommended, true);
    assert.equal(auth.pause_recommended, true);
  });
});

describe('classifyGitRemoteFailure — conflict failures (no pause)', () => {
  // Regression item 7 (brief numbering; non-fast-forward must not read as auth).
  test('non-fast-forward rejection -> GIT_NON_FAST_FORWARD, pause NOT recommended', () => {
    const result = classify(
      '! [rejected]        main -> main (non-fast-forward)\n' +
        "error: failed to push some refs to 'https://github.com/o/r.git'\n" +
        'hint: Updates were rejected because the tip of your current branch is behind\n' +
        'hint: its remote counterpart. Integrate the remote changes (e.g.\n' +
        "hint: 'git pull ...') before pushing again."
    );
    assert.equal(result.failure_kind, 'GIT_NON_FAST_FORWARD');
    assert.equal(result.pause_recommended, false);
  });

  test('"fetch first" hint alone -> GIT_NON_FAST_FORWARD, pause NOT recommended', () => {
    const result = classify(
      "error: failed to push some refs to 'https://github.com/o/r.git'\n" +
        "hint: Updates were rejected because the remote contains work that you do\n" +
        'hint: not have locally. You may want to first integrate the remote changes\n' +
        "hint: (e.g., 'git fetch first') before pushing again."
    );
    assert.equal(result.failure_kind, 'GIT_NON_FAST_FORWARD');
    assert.equal(result.pause_recommended, false);
  });

  // Regression item 8 (brief numbering; remote conflict stays fail-closed).
  test('"stale info" -> GIT_REMOTE_CONFLICT, pause NOT recommended', () => {
    const result = classify(
      "error: failed to push some refs to 'https://github.com/o/r.git'\n" +
        'hint: the remote ref was updated after the last fetch (stale info)'
    );
    assert.equal(result.failure_kind, 'GIT_REMOTE_CONFLICT');
    assert.equal(result.pause_recommended, false);
  });

  test('"remote conflict" -> GIT_REMOTE_CONFLICT, pause NOT recommended', () => {
    const result = classify('push aborted: remote conflict detected on branch main');
    assert.equal(result.failure_kind, 'GIT_REMOTE_CONFLICT');
    assert.equal(result.pause_recommended, false);
  });
});

describe('classifyGitRemoteFailure — remote unavailable', () => {
  // Regression item 9 (brief numbering).
  test('"Repository not found" -> GIT_REMOTE_UNAVAILABLE, pause recommended', () => {
    const result = classify("remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found");
    assert.equal(result.failure_kind, 'GIT_REMOTE_UNAVAILABLE');
    assert.equal(result.pause_recommended, true);
  });

  test('HTTP 404 without keywords -> GIT_REMOTE_UNAVAILABLE via http_status', () => {
    const result = classify("fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 404");
    assert.equal(result.failure_kind, 'GIT_REMOTE_UNAVAILABLE');
    assert.equal(result.http_status, 404);
    assert.equal(result.pause_recommended, true);
  });

  test('HTTP 500 -> GIT_REMOTE_UNAVAILABLE via http_status', () => {
    const result = classify("fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 500");
    assert.equal(result.failure_kind, 'GIT_REMOTE_UNAVAILABLE');
    assert.equal(result.http_status, 500);
    assert.equal(result.pause_recommended, true);
  });
});

describe('classifyGitRemoteFailure — unknown and passthrough', () => {
  // Regression item 10 (brief numbering).
  test('garbage output -> GIT_UNKNOWN_FAILURE, pause NOT recommended', () => {
    const result = classify('something weird happened');
    assert.equal(result.failure_kind, 'GIT_UNKNOWN_FAILURE');
    assert.equal(result.pause_recommended, false);
    assert.equal(result.http_status, null);
  });

  // Regression item 11 (brief numbering): remote/operation pass through unchanged.
  test('remote and operation fields pass through to the result', () => {
    const result = classifyGitRemoteFailure({
      remote: 'upstream',
      operation: 'ls-remote',
      output: 'something weird happened',
    });
    assert.equal(result.remote, 'upstream');
    assert.equal(result.operation, 'ls-remote');

    const preflight = classifyGitRemoteFailure({
      remote: 'origin',
      operation: 'preflight_write_check',
      output: "remote: Permission to o/r.git denied to user.",
    });
    assert.equal(preflight.remote, 'origin');
    assert.equal(preflight.operation, 'preflight_write_check');
  });

  // Regression item 11 (brief numbering): sanitized_message capped at 500 chars.
  test('sanitized_message is capped at 500 characters', () => {
    const longOutput = `noise prefix ${'x'.repeat(1000)}`;
    const result = classify(longOutput);
    assert.equal(result.sanitized_message.length, 500);
    assert.ok(longOutput.length > 500);
  });
});

// Regression items 18-19: secret sanitization guarantees.
describe('sanitizeGitRemoteMessage — secret redaction (items 18-19)', () => {
  test('URL with embedded credentials is redacted', () => {
    const result = classify(
      "fatal: unable to access 'https://x-access-token:ghp_secretTOKEN123@github.com/o/r.git': Could not resolve host: github.com"
    );
    assert.ok(
      !result.sanitized_message.includes('ghp_secretTOKEN123'),
      `token leaked into sanitized_message: ${result.sanitized_message}`
    );
    assert.ok(
      !result.sanitized_message.includes('x-access-token:ghp'),
      `credential pair leaked into sanitized_message: ${result.sanitized_message}`
    );
    assert.ok(
      result.sanitized_message.includes('[REDACTED]'),
      `expected [REDACTED] marker, got: ${result.sanitized_message}`
    );
  });

  test('exact GITHUB_TOKEN env value is redacted; env restored afterwards', () => {
    const previous = process.env.GITHUB_TOKEN;
    const sentinel = 'ghp_SENTINEL_test_token_456';
    process.env.GITHUB_TOKEN = sentinel;
    try {
      const result = classify(
        `fatal: Authentication failed for 'https://github.com/o/r.git' using credential ${sentinel}`
      );
      assert.ok(
        !result.sanitized_message.includes(sentinel),
        `GITHUB_TOKEN value leaked into sanitized_message: ${result.sanitized_message}`
      );
      assert.ok(result.sanitized_message.includes('[REDACTED]'));
      assert.equal(result.failure_kind, 'GIT_AUTH_INVALID');
    } finally {
      if (previous === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = previous;
      }
    }
    // Verify restoration actually happened.
    if (previous === undefined) {
      assert.equal(process.env.GITHUB_TOKEN, undefined);
    } else {
      assert.equal(process.env.GITHUB_TOKEN, previous);
    }
  });

  test('Bearer token is redacted by redactSecrets', () => {
    // src/sandbox-preflight-repair.ts redactSecrets covers /\b(Bearer\s+[a-zA-Z0-9_-]+)\b/.
    const result = classify('remote: Authorization header Bearer abcdef123456 was rejected');
    assert.ok(
      !result.sanitized_message.includes('abcdef123456'),
      `Bearer token leaked into sanitized_message: ${result.sanitized_message}`
    );
    assert.ok(result.sanitized_message.includes('[REDACTED]'));
  });

  test('github_pat_ token is redacted by redactSecrets', () => {
    // src/sandbox-preflight-repair.ts redactSecrets covers /\b(github_pat_[a-zA-Z0-9_]+)\b/.
    const pat = 'github_pat_11ABCDEFGH0_abcdefghijklmnopqrstuvwxyz0123456789';
    const result = classify(`remote: credential ${pat} was rejected`);
    assert.ok(
      !result.sanitized_message.includes(pat),
      `github_pat_ token leaked into sanitized_message: ${result.sanitized_message}`
    );
    assert.ok(result.sanitized_message.includes('[REDACTED]'));
  });

  test('sanitizeGitRemoteMessage trims and lowercases nothing of ordinary text', () => {
    const sanitized = sanitizeGitRemoteMessage('  fatal: Authentication failed  ');
    assert.equal(sanitized, 'fatal: Authentication failed');
  });
});

describe('isGitCredentialFailureKind', () => {
  // Regression item 13 (brief numbering).
  test('true for credential/access failure kinds', () => {
    assert.equal(isGitCredentialFailureKind('GIT_AUTH_INVALID'), true);
    assert.equal(isGitCredentialFailureKind('GIT_AUTH_EXPIRED'), true);
    assert.equal(isGitCredentialFailureKind('GIT_PERMISSION_DENIED'), true);
  });

  test('false for the other five kinds', () => {
    const nonCredential: GitRemoteFailureKind[] = [
      'GIT_REMOTE_UNAVAILABLE',
      'GIT_NETWORK_FAILURE',
      'GIT_NON_FAST_FORWARD',
      'GIT_REMOTE_CONFLICT',
      'GIT_UNKNOWN_FAILURE',
    ];
    for (const kind of nonCredential) {
      assert.equal(isGitCredentialFailureKind(kind), false, `${kind} must not be a credential failure kind`);
    }
  });
});
