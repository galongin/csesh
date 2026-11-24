/**
 * Tests for the workflow status feature (lib/status.js + filterSessions).
 *
 * Status is separate from classification tiers: these tests also check
 * that setting a status never changes tier/classifier output.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUSES,
  UNSORTED,
  isValidStatus,
  parseStatusInput,
  parseStatusFilter,
  effectiveStatus,
  applyStatus,
  writeStatus,
  writeImportant,
  statusCounts,
} from '../lib/status.js';
import { filterSessions } from '../lib/search.js';
import { classify } from '../lib/classifier.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeSession(overrides = {}) {
  return {
    id: 'sess-001',
    slug: 'myproject',
    shortProject: 'myproject',
    project: '/Users/dev/myproject',
    category: 'conversation',
    fileSizeBytes: 10_000,
    userMessageCount: 3,
    assistantMessageCount: 4,
    tier: 4,
    title: 'Fix the widget component',
    displayTitle: 'Fix the widget component',
    firstTimestamp: '2026-02-20T10:00:00Z',
    lastTimestamp: '2026-02-20T10:02:00Z',
    tags: [],
    autoTags: [],
    storedStatus: null,
    important: false,
    ...overrides,
  };
}

function emptyMeta() {
  return { version: 1, sessions: {}, globalTags: [] };
}

// ── Constants / validation ───────────────────────────────────────────

describe('Status — constants and validation', () => {
  it('should expose exactly backlog, wip, done', () => {
    assert.deepEqual(STATUSES, ['backlog', 'wip', 'done']);
  });

  it('should validate known statuses', () => {
    for (const s of STATUSES) assert.equal(isValidStatus(s), true);
    assert.equal(isValidStatus('important'), false);
    assert.equal(isValidStatus('pending'), false);
    assert.equal(isValidStatus(''), false);
    assert.equal(isValidStatus(null), false);
  });

  it('should parse valid input (case/whitespace insensitive)', () => {
    assert.deepEqual(parseStatusInput('WIP'), { ok: true, status: 'wip' });
    assert.deepEqual(parseStatusInput(' done '), { ok: true, status: 'done' });
  });

  it('should treat null / clear / none as clearing', () => {
    for (const v of [null, undefined, 'clear', 'CLEAR', 'none', '']) {
      assert.deepEqual(parseStatusInput(v), { ok: true, status: null });
    }
  });

  it('should reject invalid values', () => {
    for (const v of ['important', 'pending', 'archived', 42, true, {}, ['wip']]) {
      const r = parseStatusInput(v);
      assert.equal(r.ok, false, `expected ${JSON.stringify(v)} to be rejected`);
      assert.match(r.error, /backlog, wip, done/);
    }
  });
});

// ── Effective status defaults ────────────────────────────────────────

describe('Status — effective status defaults', () => {
  it('should default Keep (tier 4) to backlog', () => {
    assert.equal(effectiveStatus(makeSession({ tier: 4 })), 'backlog');
  });

  it('should default Review (tier 3) to backlog', () => {
    assert.equal(effectiveStatus(makeSession({ tier: 3 })), 'backlog');
  });

  it('should leave Suggested (tier 2) unsorted', () => {
    assert.equal(effectiveStatus(makeSession({ tier: 2 })), null);
  });

  it('should leave Auto-delete (tier 1) unsorted', () => {
    assert.equal(effectiveStatus(makeSession({ tier: 1 })), null);
  });

  it('should put an important but otherwise unsorted session in backlog', () => {
    assert.equal(effectiveStatus(makeSession({ tier: 1, important: true })), 'backlog');
  });

  it('should return null for a missing session', () => {
    assert.equal(effectiveStatus(null), null);
  });
});

// ── Explicit override ────────────────────────────────────────────────

describe('Status — explicit override', () => {
  it('should let an explicit status override the tier default', () => {
    assert.equal(effectiveStatus(makeSession({ tier: 4, storedStatus: 'done' })), 'done');
    assert.equal(effectiveStatus(makeSession({ tier: 1, storedStatus: 'wip' })), 'wip');
    assert.equal(effectiveStatus(makeSession({ tier: 2, storedStatus: 'backlog' })), 'backlog');
  });

  it('should ignore an invalid stored value and fall back to the default', () => {
    assert.equal(effectiveStatus(makeSession({ tier: 4, storedStatus: 'bogus' })), 'backlog');
    assert.equal(effectiveStatus(makeSession({ tier: 1, storedStatus: 'bogus' })), null);
  });

  it('applyStatus should set status and statusExplicit', () => {
    const sessions = [
      makeSession({ id: 'a', tier: 4 }),
      makeSession({ id: 'b', tier: 1, storedStatus: 'wip' }),
      makeSession({ id: 'c', tier: 2 }),
    ];
    applyStatus(sessions);
    assert.deepEqual(sessions.map(s => [s.status, s.statusExplicit]), [
      ['backlog', false],
      ['wip', true],
      [null, false],
    ]);
  });
});

// ── Writing / clearing in the metadata sidecar ───────────────────────

describe('Status — metadata writes and clearing', () => {
  it('should store a status in the sidecar record', () => {
    const meta = emptyMeta();
    writeStatus(meta, 'sess-1', 'wip');
    assert.equal(meta.sessions['sess-1'].status, 'wip');
    assert.ok(meta.sessions['sess-1'].updatedAt);
  });

  it('should overwrite an existing status', () => {
    const meta = emptyMeta();
    writeStatus(meta, 'sess-1', 'wip');
    writeStatus(meta, 'sess-1', 'done');
    assert.equal(meta.sessions['sess-1'].status, 'done');
  });

  it('should clear a status with null (key removed, other fields kept)', () => {
    const meta = emptyMeta();
    meta.sessions['sess-1'] = { customTitle: 'Keep me', tags: ['x'], status: 'done' };
    writeStatus(meta, 'sess-1', null);
    assert.equal('status' in meta.sessions['sess-1'], false);
    assert.equal(meta.sessions['sess-1'].customTitle, 'Keep me');
    assert.deepEqual(meta.sessions['sess-1'].tags, ['x']);
  });

  it('should fall back to the tier default after clearing', () => {
    const meta = emptyMeta();
    writeStatus(meta, 'sess-1', 'done');
    writeStatus(meta, 'sess-1', null);
    const s = makeSession({ tier: 3, storedStatus: meta.sessions['sess-1'].status || null });
    assert.equal(effectiveStatus(s), 'backlog');
  });

  it('should reject invalid values without touching the sidecar', () => {
    const meta = emptyMeta();
    assert.throws(() => writeStatus(meta, 'sess-1', 'important'), /Invalid status/);
    assert.deepEqual(meta.sessions, {});
  });

  it('should not touch tierOverride when writing status', () => {
    const meta = emptyMeta();
    meta.sessions['sess-1'] = { tierOverride: 2 };
    writeStatus(meta, 'sess-1', 'wip');
    assert.equal(meta.sessions['sess-1'].tierOverride, 2);
  });

  it('should set and clear the important flag independently of status', () => {
    const meta = emptyMeta();
    writeStatus(meta, 'sess-1', 'backlog');
    writeImportant(meta, 'sess-1', true);
    assert.equal(meta.sessions['sess-1'].important, true);
    assert.equal(meta.sessions['sess-1'].status, 'backlog');
    writeImportant(meta, 'sess-1', false);
    assert.equal('important' in meta.sessions['sess-1'], false);
    assert.equal(meta.sessions['sess-1'].status, 'backlog');
  });

  it('should survive a JSON round-trip (persistence format)', () => {
    const meta = emptyMeta();
    writeStatus(meta, 'sess-1', 'wip');
    writeImportant(meta, 'sess-1', true);
    const reloaded = JSON.parse(JSON.stringify(meta));
    assert.equal(reloaded.sessions['sess-1'].status, 'wip');
    assert.equal(reloaded.sessions['sess-1'].important, true);
  });
});

// ── Filtering (shared by API ?status= and CLI --status) ──────────────

describe('Status — filtering', () => {
  function fixture() {
    return applyStatus([
      makeSession({ id: 'keep-default', tier: 4, lastTimestamp: '2026-03-05T00:00:00Z' }),
      makeSession({ id: 'review-default', tier: 3, lastTimestamp: '2026-03-04T00:00:00Z' }),
      makeSession({ id: 'junk-default', tier: 1, lastTimestamp: '2026-03-03T00:00:00Z' }),
      makeSession({ id: 'wip-explicit', tier: 2, storedStatus: 'wip', lastTimestamp: '2026-03-06T00:00:00Z' }),
      makeSession({ id: 'done-explicit', tier: 4, storedStatus: 'done', lastTimestamp: '2026-03-01T00:00:00Z' }),
      makeSession({ id: 'important', tier: 4, important: true, lastTimestamp: '2026-03-02T00:00:00Z' }),
    ]);
  }
  const ids = r => r.sessions.map(s => s.id);

  it('should return everything when no status filter is given', () => {
    assert.equal(filterSessions(fixture()).total, 6);
    assert.equal(filterSessions(fixture(), { status: 'all' }).total, 6);
  });

  it('should filter by a single effective status', () => {
    assert.deepEqual(ids(filterSessions(fixture(), { status: 'wip' })), ['wip-explicit']);
    assert.deepEqual(ids(filterSessions(fixture(), { status: 'done' })), ['done-explicit']);
    assert.deepEqual(
      ids(filterSessions(fixture(), { status: 'backlog' })),
      ['keep-default', 'review-default', 'important'],
    );
  });

  it('should filter unsorted sessions', () => {
    assert.deepEqual(ids(filterSessions(fixture(), { status: UNSORTED })), ['junk-default']);
  });

  it('should accept a comma list and sort by last activity', () => {
    assert.deepEqual(
      ids(filterSessions(fixture(), { status: 'backlog,wip' })),
      ['wip-explicit', 'keep-default', 'review-default', 'important'],
    );
  });

  it('should filter by the important flag', () => {
    assert.deepEqual(ids(filterSessions(fixture(), { important: true })), ['important']);
  });

  it('should reject unknown status filters', () => {
    assert.throws(() => filterSessions(fixture(), { status: 'pending' }), /Unknown status filter/);
    assert.throws(() => parseStatusFilter('wip,nope'), /Unknown status filter/);
  });

  it('should work on sessions without precomputed status', () => {
    const raw = [makeSession({ id: 'x', tier: 4 }), makeSession({ id: 'y', tier: 1 })];
    assert.deepEqual(ids(filterSessions(raw, { status: 'backlog' })), ['x']);
  });
});

// ── Counts ───────────────────────────────────────────────────────────

describe('Status — counts', () => {
  it('should count sessions per effective status', () => {
    const sessions = applyStatus([
      makeSession({ tier: 4 }),
      makeSession({ tier: 3, storedStatus: 'wip', important: true }),
      makeSession({ tier: 4, storedStatus: 'done' }),
      makeSession({ tier: 1 }),
      makeSession({ tier: 2 }),
    ]);
    assert.deepEqual(statusCounts(sessions), { backlog: 1, wip: 1, done: 1, unsorted: 2, important: 1 });
  });
});

// ── Independence from the classifier ─────────────────────────────────

describe('Status — classification is unaffected', () => {
  it('should produce identical tiers with or without a status', () => {
    const base = {
      category: 'conversation', fileSizeBytes: 300, userMessageCount: 0, assistantMessageCount: 0,
      durationMs: 0, totalToolCalls: 0, turnCount: 0, thinkingBlocks: 0, uniqueFilesCount: 0, title: '',
    };
    const plain = classify({ ...base });
    const withStatus = classify({ ...base, storedStatus: 'wip', important: true, status: 'wip' });
    assert.equal(withStatus.tier, plain.tier);
    assert.equal(withStatus.tierLabel, plain.tierLabel);
    assert.deepEqual(withStatus.junkReasons, plain.junkReasons);
  });
});
