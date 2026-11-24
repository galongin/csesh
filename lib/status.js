/**
 * csesh — Claude Code session manager
 * Copyright (c) 2025-2026 Arthur Pacaud (@ArthurPcd)
 * Licensed under Apache-2.0
 * https://github.com/ArthurPcd/csesh
 */

/**
 * Workflow status — a personal "what am I doing with this session" field.
 *
 * Completely separate from the classification tiers (Keep / Review /
 * Suggested / Auto-delete): the classifier and cleanup never read it.
 *
 *   status    — 'backlog' | 'wip' | 'done' (stored in metadata.json)
 *   important — boolean flag, independent of status
 *
 * Pure functions only (no I/O) so they can be unit-tested directly.
 */

import { TIER_KEEP, TIER_REVIEW } from './classifier.js';

export const STATUSES = ['backlog', 'wip', 'done'];
export const STATUS_LABELS = { backlog: 'Backlog', wip: 'WIP', done: 'Done' };
/** Pseudo-status used for filtering sessions that have no effective status. */
export const UNSORTED = 'unsorted';

export function isValidStatus(value) {
  return STATUSES.includes(value);
}

/**
 * Normalize user input for "set status".
 * Returns { ok: true, status } where status is a valid value or null (= clear),
 * or { ok: false, error }.
 * Accepts null / 'clear' / 'none' (any case) to clear.
 */
export function parseStatusInput(value) {
  if (value === null || value === undefined) return { ok: true, status: null };
  if (typeof value !== 'string') return { ok: false, error: `status must be one of: ${STATUSES.join(', ')}, or null` };
  const v = value.trim().toLowerCase();
  if (v === 'clear' || v === 'none' || v === '') return { ok: true, status: null };
  if (isValidStatus(v)) return { ok: true, status: v };
  return { ok: false, error: `status must be one of: ${STATUSES.join(', ')}, or null` };
}

/**
 * THE single rule for a session's effective status. Used by API, CLI and dashboard.
 *
 * 1. An explicitly stored status always wins.
 * 2. Otherwise tier Keep (4) or Review (3) -> 'backlog'
 *    (new real sessions land in the backlog automatically).
 * 3. Otherwise, an important-flagged session -> 'backlog' (so it is never hidden).
 * 4. Otherwise (Suggested / Auto-delete) -> null ("unsorted").
 */
export function effectiveStatus(session) {
  if (!session) return null;
  if (isValidStatus(session.storedStatus)) return session.storedStatus;
  if (session.tier === TIER_KEEP || session.tier === TIER_REVIEW) return 'backlog';
  if (session.important) return 'backlog';
  return null;
}

/**
 * Set `status` (effective) and `statusExplicit` on session objects in-place.
 * Must run after classifyAll() and mergeMetadata().
 */
export function applyStatus(sessions) {
  for (const s of sessions) {
    s.status = effectiveStatus(s);
    s.statusExplicit = isValidStatus(s.storedStatus);
    s.important = !!s.important;
  }
  return sessions;
}

/**
 * Write a status into a metadata object (mutates). status=null clears it.
 * Returns the session's metadata record.
 */
export function writeStatus(meta, id, status) {
  if (status !== null && !isValidStatus(status)) {
    throw new Error(`Invalid status: ${status}`);
  }
  if (!meta.sessions[id]) meta.sessions[id] = {};
  const rec = meta.sessions[id];
  if (status === null) delete rec.status;
  else rec.status = status;
  rec.updatedAt = new Date().toISOString();
  return rec;
}

/** Write the important flag into a metadata object (mutates). */
export function writeImportant(meta, id, important) {
  if (!meta.sessions[id]) meta.sessions[id] = {};
  const rec = meta.sessions[id];
  if (important) rec.important = true;
  else delete rec.important;
  rec.updatedAt = new Date().toISOString();
  return rec;
}

/**
 * Parse a status filter: 'wip', 'backlog,wip', 'unsorted', 'all'.
 * Returns an array of wanted values (null entry = unsorted) or null for no filter.
 * Throws on unknown values.
 */
export function parseStatusFilter(value) {
  if (value == null || value === '' || value === 'all') return null;
  const parts = String(value).toLowerCase().split(',').map(p => p.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (p === UNSORTED) out.push(null);
    else if (isValidStatus(p)) out.push(p);
    else throw new Error(`Unknown status filter: ${p} (use ${STATUSES.join(', ')}, ${UNSORTED})`);
  }
  return out;
}

/** Count sessions per effective status (+ important). */
export function statusCounts(sessions) {
  const counts = { backlog: 0, wip: 0, done: 0, unsorted: 0, important: 0 };
  for (const s of sessions) {
    const st = s.status !== undefined ? s.status : effectiveStatus(s);
    counts[st || UNSORTED]++;
    if (s.important) counts.important++;
  }
  return counts;
}
