/**
 * csesh — Claude Code session manager
 * Copyright (c) 2025-2026 Arthur Pacaud (@ArthurPcd)
 * Licensed under Apache-2.0
 * https://github.com/ArthurPcd/csesh
 */

/**
 * Remote machines — pull-only mirrors of other machines' ~/.claude/projects.
 *
 *   remotes.json        user config: [{ name, target, aliases?, claude? }]   (hand-editable)
 *                       claude = command that starts Claude Code there (default "claude")
 *   remotes-state.json  last sync result per remote                 (written by csesh)
 *   remotes/<name>/projects/<slug>/<id>.jsonl                       (local mirror)
 *
 * Sync uses rsync over ssh (your ~/.ssh/config applies: jump hosts, keys, ...).
 * Nothing is ever written to the remote machine. Remote sessions are read-only
 * in csesh: they are never trashed, cleaned up or slug-renamed.
 */

import { readFile, writeFile, mkdir, readdir, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { hostname } from 'os';
import { execFile } from 'child_process';
import { TOOL_DIR } from './utils.js';

export const REMOTES_FILE = join(TOOL_DIR, 'remotes.json');
export const REMOTES_STATE_FILE = join(TOOL_DIR, 'remotes-state.json');
export const REMOTES_DIR = join(TOOL_DIR, 'remotes');
export const SYNC_TIMEOUT_MS = 15 * 60_000;

/** Short hostname of this machine (used as `host` for local sessions). */
export const LOCAL_HOST = hostname().split('.')[0];

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/i;
// [user@]host — no leading '-', no spaces/shell metacharacters (passed to rsync/ssh as argv)
const TARGET_RE = /^(?:[a-z0-9._][a-z0-9._-]{0,63}@)?[a-z0-9][a-z0-9.-]{0,252}$/i;
// Command name or path (e.g. hclaude, /opt/bin/claude) — one plain shell word, no leading '-'
const CLAUDE_CMD_RE = /^[a-z0-9_.\/][a-z0-9_.\/+-]{0,127}$/i;
export const DEFAULT_CLAUDE_CMD = 'claude';

// ── Validation (pure) ────────────────────────────────────────────────

export function validateRemoteName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    return 'name must be 1-63 chars: letters, digits, dot, dash, underscore (no leading dot/dash)';
  }
  if (name.toLowerCase() === LOCAL_HOST.toLowerCase() || name.toLowerCase() === 'local') {
    return `name "${name}" is reserved for this machine`;
  }
  return null;
}

export function validateTarget(target) {
  if (typeof target !== 'string' || !TARGET_RE.test(target)) {
    return 'target must look like user@host or host (ssh destination)';
  }
  return null;
}

export function validateClaudeCommand(cmd) {
  if (typeof cmd !== 'string' || !CLAUDE_CMD_RE.test(cmd)) {
    return 'claude command must be a plain command name or path (letters, digits, . _ / + -)';
  }
  return null;
}

/** Build the rsync argv for a remote (pure, exported for tests). */
export function rsyncArgs(remote, destDir) {
  return [
    '-a', '-z', '--delete', '--prune-empty-dirs', '--timeout=60',
    '-e', 'ssh -o BatchMode=yes -o ConnectTimeout=15',
    // Only top-level session files: <slug>/<id>.jsonl (same files the scanner reads)
    '--include=/*/', '--include=/*/*.jsonl', '--exclude=*',
    // Relative path = remote $HOME, so no tilde expansion (works with csh/tcsh login shells)
    `${remote.target}:.claude/projects/`,
    destDir.endsWith('/') ? destDir : destDir + '/',
  ];
}

// ── Config / state I/O ───────────────────────────────────────────────

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf-8')); }
  catch { return fallback; }
}

async function writeJson(file, data) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

export async function loadRemotes() {
  const cfg = await readJson(REMOTES_FILE, null);
  const list = Array.isArray(cfg) ? cfg : (cfg?.remotes || []);
  return list
    .filter(r => r && !validateRemoteName(r.name) && !validateTarget(r.target))
    // A bad claude command falls back to the default rather than hiding the machine
    .map(r => (r.claude !== undefined && validateClaudeCommand(r.claude) ? (({ claude, ...rest }) => rest)(r) : r));
}

async function saveRemotes(remotes) {
  await writeJson(REMOTES_FILE, { version: 1, remotes });
}

export async function loadRemoteState() {
  return await readJson(REMOTES_STATE_FILE, {});
}

export function mirrorDir(name) {
  return join(REMOTES_DIR, name, 'projects');
}

export async function addRemote({ name, target, aliases = [], claude = null }) {
  const nameErr = validateRemoteName(name);
  if (nameErr) throw new Error(nameErr);
  const targetErr = validateTarget(target);
  if (targetErr) throw new Error(targetErr);
  if (claude) {
    const claudeErr = validateClaudeCommand(claude);
    if (claudeErr) throw new Error(claudeErr);
  }
  const remotes = await loadRemotes();
  if (remotes.some(r => r.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`remote "${name}" already exists`);
  }
  const entry = { name, target };
  const cleanAliases = (aliases || []).map(a => String(a).trim()).filter(Boolean);
  if (cleanAliases.length) entry.aliases = cleanAliases;
  if (claude && claude !== DEFAULT_CLAUDE_CMD) entry.claude = claude;
  remotes.push(entry);
  await saveRemotes(remotes);
  return entry;
}

/** Remove a remote. purge=true also deletes the local mirror. */
export async function removeRemote(name, { purge = false } = {}) {
  const remotes = await loadRemotes();
  const idx = remotes.findIndex(r => r.name === name);
  if (idx < 0) throw new Error(`remote "${name}" not found`);
  remotes.splice(idx, 1);
  await saveRemotes(remotes);
  const state = await loadRemoteState();
  delete state[name];
  await writeJson(REMOTES_STATE_FILE, state);
  if (purge) await rm(join(REMOTES_DIR, name), { recursive: true, force: true });
  return { removed: name, purged: purge };
}

// ── Sync ─────────────────────────────────────────────────────────────

function run(cmd, args, timeout) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** Pick the most useful line out of ssh/rsync stderr (remote login shells can be noisy). */
function summarizeError(err, stderr) {
  if (err?.code === 'ENOENT') return 'rsync not found on this machine';
  if (err?.killed) return `timed out after ${Math.round(SYNC_TIMEOUT_MS / 60000)} min`;
  const lines = stderr.split('\n').map(l => l.trim()).filter(Boolean);
  const pick = lines.find(l => /permission denied|could not resolve|timed out|connection (refused|closed|reset)|no route|host key|No such file|rsync error|not found/i.test(l));
  return pick || lines[lines.length - 1] || err?.message || 'sync failed';
}

async function countMirrorSessions(name) {
  let count = 0;
  try {
    for (const slug of await readdir(mirrorDir(name))) {
      try { count += (await readdir(join(mirrorDir(name), slug))).filter(f => f.endsWith('.jsonl')).length; }
      catch { /* not a dir */ }
    }
  } catch { /* no mirror yet */ }
  return count;
}

/**
 * Sync one remote. Never throws; returns a result record (not persisted —
 * use syncRemotes() which saves state once for the whole run).
 */
export async function syncRemote(remote, { runner = run, previous = null } = {}) {
  const started = Date.now();
  const dest = mirrorDir(remote.name);
  await mkdir(dest, { recursive: true });
  const { err, stderr } = await runner('rsync', rsyncArgs(remote, dest), SYNC_TIMEOUT_MS);
  // rsync exit 24 = some files vanished during transfer (session still being written) — fine
  const ok = !err || err.code === 24;
  const at = new Date().toISOString();
  return {
    name: remote.name,
    at,
    ok,
    durationMs: Date.now() - started,
    sessions: await countMirrorSessions(remote.name),
    error: ok ? null : summarizeError(err, stderr),
    // Keep the last good sync time even when this one failed
    lastOkAt: ok ? at : (previous?.lastOkAt || null),
  };
}

/** Sync several remotes in parallel (all by default) and persist their results. */
export async function syncRemotes(names = null, opts = {}) {
  const remotes = await loadRemotes();
  const missing = (names || []).filter(n => !remotes.some(r => r.name === n));
  if (missing.length) throw new Error(`unknown remote: ${missing.join(', ')}`);
  const selected = names?.length ? remotes.filter(r => names.includes(r.name)) : remotes;
  const before = await loadRemoteState();
  const results = await Promise.all(selected.map(r => syncRemote(r, { ...opts, previous: before[r.name] })));
  const state = await loadRemoteState();
  for (const { name, ...rest } of results) state[name] = rest;
  await writeJson(REMOTES_STATE_FILE, state);
  return results;
}

// ── Scanning ─────────────────────────────────────────────────────────

/**
 * Session files from all remote mirrors, tagged with host info.
 * Same shape as scanner.findSessionFiles() entries plus { host, remote, remoteTarget }.
 */
export async function findRemoteSessionFiles({ projectSlug = null, host = null } = {}) {
  const remotes = await loadRemotes();
  const files = [];
  for (const r of remotes) {
    if (host && r.name !== host) continue;
    const root = mirrorDir(r.name);
    let slugs;
    try { slugs = projectSlug ? [projectSlug] : await readdir(root); }
    catch { continue; } // never synced
    for (const slug of slugs) {
      let entries;
      try { entries = await readdir(join(root, slug)); }
      catch { continue; }
      for (const name of entries) {
        if (!name.endsWith('.jsonl')) continue;
        files.push({
          id: name.slice(0, -'.jsonl'.length),
          filePath: join(root, slug, name),
          projectSlug: slug,
          host: r.name,
          remote: true,
          remoteTarget: r.target,
          remoteClaude: r.claude || DEFAULT_CLAUDE_CMD,
        });
      }
    }
  }
  return files;
}

/** Tag a scanned summary with host info from its file entry (mutates, returns summary). */
export function tagHost(summary, file) {
  summary.host = file.host || LOCAL_HOST;
  summary.remote = !!file.remote;
  if (file.remote) {
    summary.remoteTarget = file.remoteTarget;
    summary.remoteClaude = file.remoteClaude || DEFAULT_CLAUDE_CMD;
  } else {
    delete summary.remoteTarget;
    delete summary.remoteClaude;
  }
  return summary;
}

/** POSIX/csh-safe single-quote for a remote shell word (plain paths stay unquoted). */
export function shq(s) {
  s = String(s);
  if (/^[A-Za-z0-9_\/.,:=@%+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Shell command to resume a remote session from this machine. */
export function remoteResumeCommand(session) {
  const dir = session.cwd || session.project || '~';
  return `ssh -t ${session.remoteTarget} ${shq(remoteShellCommand(session, dir))}`;
}

/** Remote argv for `ssh -t target <cmd>` (no local shell involved). */
export function remoteResumeArgv(session) {
  const dir = session.cwd || session.project || '~';
  return ['-t', session.remoteTarget, remoteShellCommand(session, dir)];
}

function remoteShellCommand(session, dir) {
  const cmd = session.remoteClaude && !validateClaudeCommand(session.remoteClaude) ? session.remoteClaude : DEFAULT_CLAUDE_CMD;
  return `cd ${shq(dir)} && ${cmd} --resume ${session.id}`;
}
