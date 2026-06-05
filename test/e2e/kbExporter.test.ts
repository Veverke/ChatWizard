// test/e2e/kbExporter.test.ts
// Feature 23 — KB Entry Markdown Exporter

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exportKbAsync } from '../../src/export/kbExporter';
import type { KbEntry } from '../../src/types/kb';

function makeEntry(id: string, type: KbEntry['type'], tags: string[] = []): KbEntry {
    return {
        sessionId: id,
        type,
        title: `${type} entry ${id}`,
        summary: `Summary for ${id}`,
        tags,
        createdAt: '2026-06-01T10:00:00Z',
    };
}

suite('Feature 23 — KB Exporter', () => {
    let tmpDir: string;

    suiteSetup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-kb-test-'));
    });

    suiteTeardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('creates expected directory structure for two entries', async () => {
        const outDir = path.join(tmpDir, 'kb1');
        const entries = [
            makeEntry('sess-001', 'decision'),
            makeEntry('sess-002', 'learning'),
        ];
        await exportKbAsync(entries, new Map(), outDir, { incrementalUpdate: false });

        assert.ok(fs.existsSync(path.join(outDir, 'index.md')), 'index.md should exist');
        assert.ok(fs.existsSync(path.join(outDir, 'decisions', 'sess-001.md')), 'decision file should exist');
        assert.ok(fs.existsSync(path.join(outDir, 'learnings', 'sess-002.md')), 'learning file should exist');
    });

    test('index.md contains links to all entries', async () => {
        const outDir = path.join(tmpDir, 'kb2');
        const entries = [
            makeEntry('a001', 'decision'),
            makeEntry('a002', 'gotcha'),
            makeEntry('a003', 'pattern'),
        ];
        await exportKbAsync(entries, new Map(), outDir, { incrementalUpdate: false });

        const index = fs.readFileSync(path.join(outDir, 'index.md'), 'utf8');
        assert.ok(index.includes('a001'), 'index should reference entry a001');
        assert.ok(index.includes('a002'), 'index should reference entry a002');
        assert.ok(index.includes('a003'), 'index should reference entry a003');
    });

    test('entry file contains YAML frontmatter with sessionId', async () => {
        const outDir = path.join(tmpDir, 'kb3');
        const entries = [makeEntry('sess-xyz', 'architecture')];
        await exportKbAsync(entries, new Map(), outDir, { incrementalUpdate: false });

        const content = fs.readFileSync(path.join(outDir, 'architecture', 'sess-xyz.md'), 'utf8');
        assert.ok(content.startsWith('---'), 'should start with YAML frontmatter');
        assert.ok(content.includes('sessionId: sess-xyz'), 'should include sessionId');
        assert.ok(content.includes('type: architecture'), 'should include type');
    });

    test('entry file contains the title in an h1 tag', async () => {
        const outDir = path.join(tmpDir, 'kb4');
        const entries = [makeEntry('h1-test', 'learning')];
        await exportKbAsync(entries, new Map(), outDir, { incrementalUpdate: false });

        const content = fs.readFileSync(path.join(outDir, 'learnings', 'h1-test.md'), 'utf8');
        assert.ok(content.includes('# learning entry h1-test'), 'should have h1 title');
    });

    test('incrementalUpdate: true skips locked files', async () => {
        const outDir = path.join(tmpDir, 'kb5');
        const entries = [makeEntry('locked-001', 'decision')];

        // First export
        await exportKbAsync(entries, new Map(), outDir, { incrementalUpdate: false });

        // Manually add locked: true to the file
        const filePath = path.join(outDir, 'decisions', 'locked-001.md');
        const existing = fs.readFileSync(filePath, 'utf8');
        const locked = existing.replace('locked: false', 'locked: true');
        fs.writeFileSync(filePath, locked, 'utf8');

        // Change the entry's summary
        const updatedEntries = [{ ...entries[0], summary: 'UPDATED SUMMARY' }];

        // Second export with incrementalUpdate: true
        await exportKbAsync(updatedEntries, new Map(), outDir, { incrementalUpdate: true });

        // Locked file should NOT have been overwritten
        const afterContent = fs.readFileSync(filePath, 'utf8');
        assert.ok(!afterContent.includes('UPDATED SUMMARY'), 'locked file should not be overwritten');
        assert.ok(afterContent.includes('locked: true'), 'locked: true should still be in the file');
    });

    test('incrementalUpdate: false overwrites locked files', async () => {
        const outDir = path.join(tmpDir, 'kb6');
        const entries = [makeEntry('overwrite-001', 'pattern')];
        await exportKbAsync(entries, new Map(), outDir, { incrementalUpdate: false });

        const filePath = path.join(outDir, 'patterns', 'overwrite-001.md');
        const existing = fs.readFileSync(filePath, 'utf8');
        const locked = existing.replace('locked: false', 'locked: true');
        fs.writeFileSync(filePath, locked, 'utf8');

        const updatedEntries = [{ ...entries[0], summary: 'FORCED UPDATE' }];
        await exportKbAsync(updatedEntries, new Map(), outDir, { incrementalUpdate: false });

        const afterContent = fs.readFileSync(filePath, 'utf8');
        assert.ok(afterContent.includes('FORCED UPDATE'), 'file should be overwritten when incrementalUpdate is false');
    });
});