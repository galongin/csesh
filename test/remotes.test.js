/**
 * Tests for remote machines (lib/remotes.js) and host filtering.
 *
 * Only pure helpers are tested here (validation, rsync argv, quoting,
 * host tagging/filtering) — no ssh/rsync is executed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  LOCAL_HOST,
  validateRemoteName,
  validateTarget,
  rsyncArgs,
  tagHost,
  shq,
  remoteResumeArgv,
  remoteResumeCommand,
  validateClaudeCommand,
} from '../lib/remotes.js';
import { filterSessions } from '../lib/search.js';

describe('Remotes — validation', () => {
  it('should accept the configured machines', () => {
    for (const t of ['alice@10.0.0.5', 'bob@dev-box.example.com', 'alice@10.0.0.6', 'build-gw.corp.example.com']) {
      assert.equal(validateTarget(t), null, t);
    }
    for (const n of ['build-gw', 'dev-box', 'lab-box', 'box_2.lab']) {
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
  const args = rsyncArgs({ name: 'build-gw', target: 'alice@10.0.0.5' }, '/mirror/build-gw/projects');

  it('should pull from the remote home-relative projects dir into the mirror', () => {
    assert.equal(args.at(-2), 'alice@10.0.0.5:.claude/projects/');
    assert.equal(args.at(-1), '/mirror/build-gw/projects/');
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
    const remote = tagHost({ id: 'b' }, { id: 'b', host: 'build-gw', remote: true, remoteTarget: 'alice@10.0.0.5' });
    assert.deepEqual([remote.host, remote.remote, remote.remoteTarget], ['build-gw', true, 'alice@10.0.0.5']);
  });

  it('should drop stale remote info when a cached object is re-tagged as local', () => {
    const s = { id: 'c', remote: true, remoteTarget: 'x@y', host: 'old' };
    tagHost(s, { id: 'c' });
    assert.equal(s.remote, false);
    assert.equal('remoteTarget' in s, false);
  });

  const sessions = [
    { id: '1', host: LOCAL_HOST, remote: false, lastTimestamp: '2026-01-03T00:00:00Z', tier: 4 },
    { id: '2', host: 'build-gw', remote: true, lastTimestamp: '2026-01-02T00:00:00Z', tier: 4 },
    { id: '3', host: 'lab-box', remote: true, lastTimestamp: '2026-01-01T00:00:00Z', tier: 4 },
  ];
  const ids = r => r.sessions.map(s => s.id);

  it('should filter by host name (case-insensitive) and comma lists', () => {
    assert.deepEqual(ids(filterSessions(sessions, { host: 'BUILD-GW' })), ['2']);
    assert.deepEqual(ids(filterSessions(sessions, { host: 'build-gw,lab-box' })), ['2', '3']);
  });

  it("should treat 'local' as this machine", () => {
    assert.deepEqual(ids(filterSessions(sessions, { host: 'local' })), ['1']);
  });

  it('should match host in free-text search', () => {
    assert.deepEqual(ids(filterSessions(sessions, { query: 'lab-box' })), ['3']);
  });
});

describe('Remotes — resume command', () => {
  it('should leave plain paths unquoted', () => {
    assert.equal(shq('/local/users/alice/project'), '/local/users/alice/project');
    assert.equal(
      remoteResumeCommand({ id: 'abc', cwd: '/home/alice/x', remoteTarget: 'alice@10.0.0.6' }),
      "ssh -t alice@10.0.0.6 'cd /home/alice/x && claude --resume abc'",
    );
  });

  it('should use the per-machine claude command (e.g. hclaude wrapper)', () => {
    const session = { id: 'abc', cwd: '/space/x', remoteTarget: 'u@h', remoteClaude: 'hclaude' };
    assert.equal(remoteResumeCommand(session), "ssh -t u@h 'cd /space/x && hclaude --resume abc'");
    assert.equal(remoteResumeArgv(session)[2], 'cd /space/x && hclaude --resume abc');
  });

  it('should fall back to claude when the configured command is unsafe', () => {
    for (const bad of ['-x', 'a b', 'x;rm -rf ~', '$(id)', '', 42]) {
      assert.notEqual(validateClaudeCommand(bad), null, String(bad));
    }
    for (const ok of ['hclaude', '/opt/bin/claude', 'claude-2.1']) assert.equal(validateClaudeCommand(ok), null, ok);
    const session = { id: 'abc', cwd: '/x', remoteTarget: 'u@h', remoteClaude: 'x;id' };
    assert.equal(remoteResumeArgv(session)[2], 'cd /x && claude --resume abc');
  });

  it('should carry the claude command through host tagging', () => {
    const s = tagHost({ id: 'r' }, { id: 'r', host: 'build-gw', remote: true, remoteTarget: 'u@h', remoteClaude: 'hclaude' });
    assert.equal(s.remoteClaude, 'hclaude');
    tagHost(s, { id: 'r' });
    assert.equal('remoteClaude' in s, false);
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

describe('Remotes — disable / enable', () => {
  // Runs in a child process with a throwaway HOME so the real remotes.json is never touched
  const run = code => {
    const home = mkdtempSync(join(tmpdir(), 'csesh-remotes-'));
    try {
      return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
        const m = await import(${JSON.stringify(new URL('../lib/remotes.js', import.meta.url).href)});
        const synced = [];
        const runner = async (cmd, args) => { synced.push(args.at(-2).split(':')[0]); return { err: null, stdout: '', stderr: '' }; };
        ${code}
      `], { env: { ...process.env, HOME: home }, cwd: home }).toString());
    } finally { rmSync(home, { recursive: true, force: true }); }
  };

  it('should skip disabled remotes in "sync all" but keep them configured', () => {
    const out = run(`
      await m.addRemote({ name: 'a', target: 'u@a' });
      await m.addRemote({ name: 'b', target: 'u@b' });
      await m.setRemoteDisabled('b', true);
      await m.syncRemotes(null, { runner });
      const all = await m.loadRemotes();
      console.log(JSON.stringify({ synced, names: all.map(r => r.name), b: all.find(r => r.name === 'b') }));
    `);
    assert.deepEqual(out.synced, ['u@a']);
    assert.deepEqual(out.names, ['a', 'b']);
    assert.equal(out.b.disabled, true);
  });

  it('should still sync a disabled remote when named explicitly, and re-enable it', () => {
    const out = run(`
      await m.addRemote({ name: 'b', target: 'u@b' });
      await m.setRemoteDisabled('b', true);
      await m.syncRemotes(['b'], { runner });
      await m.setRemoteDisabled('b', false);
      await m.syncRemotes(null, { runner });
      console.log(JSON.stringify({ synced, b: (await m.loadRemotes())[0] }));
    `);
    assert.deepEqual(out.synced, ['u@b', 'u@b']);
    assert.equal('disabled' in out.b, false);
  });

  it('should reject unknown remotes', () => {
    const out = run(`
      try { await m.setRemoteDisabled('nope', true); console.log('{"ok":true}'); }
      catch (e) { console.log(JSON.stringify({ error: e.message })); }
    `);
    assert.match(out.error, /not found/);
  });
});
