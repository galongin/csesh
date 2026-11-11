/**
 * Tests for remote machines (lib/remotes.js) and host filtering.
 *
 * Only pure helpers are tested here (validation, rsync argv, quoting,
 * host tagging/filtering) — no ssh/rsync is executed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import {
  LOCAL_HOST,
  validateRemoteName,
  validateTarget,
  rsyncArgs,
  tagHost,
  shq,
  remoteResumeArgv,
  remoteResumeCommand,
} from '../lib/remotes.js';
import { filterSessions } from '../lib/search.js';

describe('Remotes — validation', () => {
  it('should accept the configured machines', () => {
    for (const t of ['gall@10.205.50.101', 'm35587@lhr-dev-m35587.eng.microchip.com', 'gall@10.41.75.35', 'hl-gw101.qb.hailotech']) {
      assert.equal(validateTarget(t), null, t);
    }
    for (const n of ['hl-gw101', 'lhr-dev-m35587', 'hlo-lab168', 'box_2.lab']) {
      assert.equal(validateRemoteName(n), null, n);
    }
  });

  it('should reject targets that could inject ssh/rsync options or shell code', () => {
    for (const t of ['-oProxyCommand=sh', 'u@-oProxyCommand=sh', 'a b', 'u@h;rm -rf ~', 'u@h:path', '$(id)@h', '', null, 42]) {
      assert.notEqual(validateTarget(t), null, String(t));
    }
  });

  it('should reject bad names and reserve this machine\'s name', () => {
    for (const n of ['', '-x', '.hidden', 'a/b', 'a b', 'x'.repeat(64), 'local', LOCAL_HOST]) {
      assert.notEqual(validateRemoteName(n), null, n);
    }
  });
});

describe('Remotes — rsync arguments', () => {
  const args = rsyncArgs({ name: 'hl-gw101', target: 'gall@10.205.50.101' }, '/mirror/hl-gw101/projects');

  it('should pull from the remote home-relative projects dir into the mirror', () => {
    assert.equal(args.at(-2), 'gall@10.205.50.101:.claude/projects/');
    assert.equal(args.at(-1), '/mirror/hl-gw101/projects/');
  });

  it('should use non-interactive ssh with a connect timeout', () => {
    const e = args[args.indexOf('-e') + 1];
    assert.match(e, /BatchMode=yes/);
    assert.match(e, /ConnectTimeout=\d+/);
  });

  it('should only copy top-level session files', () => {
    assert.ok(args.includes('--include=/*/'));
    assert.ok(args.includes('--include=/*/*.jsonl'));
    assert.equal(args.at(-3), '--exclude=*');
  });

  it('should mirror deletions (local copy matches the remote)', () => {
    assert.ok(args.includes('--delete'));
  });
});

describe('Remotes — host tagging and filtering', () => {
  it('should tag local sessions with this machine and remote ones with their name', () => {
    const local = tagHost({ id: 'a' }, { id: 'a', filePath: '/x' });
    assert.deepEqual([local.host, local.remote, 'remoteTarget' in local], [LOCAL_HOST, false, false]);
    const remote = tagHost({ id: 'b' }, { id: 'b', host: 'hl-gw101', remote: true, remoteTarget: 'gall@10.205.50.101' });
    assert.deepEqual([remote.host, remote.remote, remote.remoteTarget], ['hl-gw101', true, 'gall@10.205.50.101']);
  });

  it('should drop stale remote info when a cached object is re-tagged as local', () => {
    const s = { id: 'c', remote: true, remoteTarget: 'x@y', host: 'old' };
    tagHost(s, { id: 'c' });
    assert.equal(s.remote, false);
    assert.equal('remoteTarget' in s, false);
  });

  const sessions = [
    { id: '1', host: LOCAL_HOST, remote: false, lastTimestamp: '2026-01-03T00:00:00Z', tier: 4 },
    { id: '2', host: 'hl-gw101', remote: true, lastTimestamp: '2026-01-02T00:00:00Z', tier: 4 },
    { id: '3', host: 'hlo-lab168', remote: true, lastTimestamp: '2026-01-01T00:00:00Z', tier: 4 },
  ];
  const ids = r => r.sessions.map(s => s.id);

  it('should filter by host name (case-insensitive) and comma lists', () => {
    assert.deepEqual(ids(filterSessions(sessions, { host: 'HL-GW101' })), ['2']);
    assert.deepEqual(ids(filterSessions(sessions, { host: 'hl-gw101,hlo-lab168' })), ['2', '3']);
  });

  it("should treat 'local' as this machine", () => {
    assert.deepEqual(ids(filterSessions(sessions, { host: 'local' })), ['1']);
  });

  it('should match host in free-text search', () => {
    assert.deepEqual(ids(filterSessions(sessions, { query: 'lab168' })), ['3']);
  });
});

describe('Remotes — resume command', () => {
  it('should leave plain paths unquoted', () => {
    assert.equal(shq('/local/users/gall/platform-sw'), '/local/users/gall/platform-sw');
    assert.equal(
      remoteResumeCommand({ id: 'abc', cwd: '/home/gall/x', remoteTarget: 'gall@10.41.75.35' }),
      "ssh -t gall@10.41.75.35 'cd /home/gall/x && claude --resume abc'",
    );
  });

  it('should quote paths with spaces and quotes so the remote shell sees one word', () => {
    const session = { id: 'abc', cwd: "/home/my dir/it's", remoteTarget: 'u@h' };
    const [, target, remoteCmd] = remoteResumeArgv(session);
    assert.equal(target, 'u@h');
    // What the remote (POSIX) shell does with the command: cd gets exactly the path
    const out = execFileSync('sh', ['-c', remoteCmd.replace(/^cd /, 'printf %s ').replace(/ && claude.*$/, '')]).toString();
    assert.equal(out, "/home/my dir/it's");
  });

  it('copyable command should round-trip through a local shell to the same argv', () => {
    const session = { id: 'abc', cwd: "/home/my dir/it's", remoteTarget: 'u@h' };
    const cmd = remoteResumeCommand(session).replace(/^ssh /, '');
    const argv = execFileSync('sh', ['-c', `for a in ${cmd}; do printf '%s\\n' "$a"; done`]).toString();
    // word-splitting of unquoted $a is avoided by the for-loop over the parsed words
    assert.deepEqual(argv.trimEnd().split('\n'), remoteResumeArgv(session));
  });
});
