/**
 * Session titles and project paths from Claude Code session files.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { extractTitle } from '../lib/utils.js';
import { fastScan } from '../lib/scanner.js';

async function scan(records, slug = '-home-alice-workarea-my-project') {
  const dir = await mkdtemp(join(tmpdir(), 'csesh-titles-'));
  const filePath = join(dir, 'abc.jsonl');
  await writeFile(filePath, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  try { return await fastScan({ id: 'abc', filePath, projectSlug: slug }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

const user = text => ({ type: 'user', timestamp: '2026-01-01T00:00:00Z', cwd: '/home/alice/workarea/my_project', message: { content: text } });

describe('Titles', () => {
  it('should unwrap pasted text instead of showing the tag', () => {
    assert.equal(extractTitle('\n\n<pasted_content id="4492">\nBuild a deck about X\nmore\n</pasted_content id="4492">'), 'Build a deck about X');
  });

  it("should prefer Claude Code's ai-title over the first prompt", async () => {
    const s = await scan([user('please do the thing'), { type: 'ai-title', aiTitle: 'Old title' }, { type: 'ai-title', aiTitle: 'Board flow vs SAM-BA' }]);
    assert.equal(s.title, 'Board flow vs SAM-BA');
    assert.equal(s.promptTitle, 'please do the thing');
  });

  it('should prefer a /rename custom-title over the ai-title', async () => {
    const s = await scan([user('x'), { type: 'ai-title', aiTitle: 'Auto' }, { type: 'custom-title', customTitle: 'my-name' }]);
    assert.equal(s.title, 'my-name');
  });

  it('should find a title record in the middle of a long file', async () => {
    const filler = Array.from({ length: 100 }, () => ({ type: 'attachment' }));
    const s = await scan([user('first'), ...filler, { type: 'ai-title', aiTitle: 'Middle title' }, ...filler]);
    assert.equal(s.title, 'Middle title');
  });
});

describe('Project path', () => {
  it('should use the exact cwd (underscores kept) instead of the lossy folder name', async () => {
    const s = await scan([user('hi')]);
    assert.equal(s.project, '/home/alice/workarea/my_project');
    assert.equal(s.shortProject, 'my_project');
  });

  it('should fall back to the folder name when there is no cwd', async () => {
    const s = await scan([{ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'hi' } }]);
    assert.equal(s.project, '/home/alice/workarea/my/project');
  });
});
