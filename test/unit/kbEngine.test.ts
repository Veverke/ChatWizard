/**
 * test/unit/kbEngine.test.ts
 *
 * Unit tests for kbEngine â€” shared KB engine functions.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    mergeIntoResult,
    removeFromResult,
    cleanSummary,
    buildKbEntries,
    buildKbEntriesFromClassifications,
} from '../../src/analytics/kbEngine.js';
import { ClassificationStore } from '../../src/analytics/classificationStore.js';
import { sessionFingerprintFrom } from '../../src/analytics/classificationStore.js';
import type { KbEntry, KbEntryType } from '../../src/types/kb.js';
import type { Message, Session, SessionFolder, SessionMetadata } from '../../src/types/index.js';

function makeSession(id: string, updatedAt = '2024-01-01T00:00:00Z'): Session {
    const message: Message = { id: `m-${id}`, role: 'user', content: `Prompt ${id}`, codeBlocks: [] };
    return {
        id,
        title: `Title ${id}`,
        source: 'copilot',
        messages: [message],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt,
        workspaceId: 'ws',
        workspacePath: '/ws',
        filePath: `/ws/${id}.jsonl`,
    };
}

function makeEntry(sessionId: string, type: KbEntryType): KbEntry {
    return {
        sessionId,
        type,
        subtype: undefined,
        title: `Session ${sessionId}`,
        summary: `Summary for ${sessionId}`,
        tags: [],
        createdAt: '2024-01-01T00:00:00Z',
    };
}

function makeResult(entries: KbEntry[]) {
    const grouped = new Map<KbEntryType, KbEntry[]>();
    for (const e of entries) {
        const arr = grouped.get(e.type);
        if (arr) { arr.push(e); } else { grouped.set(e.type, [e]); }
    }
    return { entries, grouped, total: entries.length, usedLlm: false };
}

suite('kbEngine', () => {
    suite('mergeIntoResult', () => {
        test('adds new entries to existing result', async () => {
            const existing = makeResult([makeEntry('s1', 'Git')]);
            const result = await mergeIntoResult(existing, [makeEntry('s2', 'Bugs')]);
            assert.strictEqual(result.total, 2);
            assert.ok(result.grouped.has('Git'));
            assert.ok(result.grouped.has('Bugs'));
        });

        test('replaces existing entry with same sessionId', async () => {
            const existing = makeResult([makeEntry('s1', 'Git')]);
            const updated = makeEntry('s1', 'Bugs');
            const result = await mergeIntoResult(existing, [updated]);
            assert.strictEqual(result.total, 1);
            assert.strictEqual(result.entries[0].type, 'Bugs');
        });

        test('preserves usedLlm flag from existing', async () => {
            const existing = { ...makeResult([]), usedLlm: true };
            const result = await mergeIntoResult(existing, [makeEntry('s1', 'Git')]);
            assert.strictEqual(result.usedLlm, true);
        });

        test('handles empty new entries', async () => {
            const existing = makeResult([makeEntry('s1', 'Git')]);
            const result = await mergeIntoResult(existing, []);
            assert.strictEqual(result.total, 1);
        });
    });

    suite('removeFromResult', () => {
        test('removes entries with matching sessionIds', () => {
            const existing = makeResult([makeEntry('s1', 'Git'), makeEntry('s2', 'Bugs')]);
            const result = removeFromResult(existing, new Set(['s1']));
            assert.strictEqual(result.total, 1);
            assert.strictEqual(result.entries[0].sessionId, 's2');
        });

        test('returns unchanged when no ids match', () => {
            const existing = makeResult([makeEntry('s1', 'Git')]);
            const result = removeFromResult(existing, new Set(['s99']));
            assert.strictEqual(result.total, 1);
        });

        test('removes empty group when last entry removed', () => {
            const existing = makeResult([makeEntry('s1', 'Git')]);
            const result = removeFromResult(existing, new Set(['s1']));
            assert.strictEqual(result.total, 0);
            assert.strictEqual(result.grouped.size, 0);
        });
    });

    suite('cleanSummary', () => {
        test('strips "User requested to" prefix', () => {
            assert.strictEqual(cleanSummary('User requested to continue a chat feature'), 'continue a chat feature');
        });

        test('strips "User is" prefix', () => {
            assert.strictEqual(cleanSummary('User is troubleshooting a Copilot extension'), 'troubleshooting a Copilot extension');
        });

        test('strips "User wants to" prefix', () => {
            assert.strictEqual(cleanSummary('User wants to refactor the module'), 'refactor the module');
        });

        test('strips "User asks to" prefix', () => {
            assert.strictEqual(cleanSummary('User asks to add a new feature'), 'add a new feature');
        });

        test('strips "User asked to" prefix', () => {
            assert.strictEqual(cleanSummary('User asked to update the config'), 'update the config');
        });

        test('returns unchanged when no prefix matches', () => {
            assert.strictEqual(cleanSummary('Fix the bug in production'), 'Fix the bug in production');
        });

        test('handles empty string', () => {
            assert.strictEqual(cleanSummary(''), '');
        });
    });

    suite('buildKbEntriesFromClassifications â€” render shared results without a model', () => {

        test('builds entries from known classifications', () => {
            const sessions = [makeSession('a'), makeSession('b')];
            const result = buildKbEntriesFromClassifications(sessions, null, [
                { sessionId: 'a', category: 'Git', subcategory: 'Branching', usedLlm: true },
                { sessionId: 'b', category: 'Bugs', usedLlm: false },
            ]);

            assert.strictEqual(result.total, 2);
            assert.strictEqual(result.usedLlm, true);
            assert.deepStrictEqual(result.grouped.get('Git')?.map(e => e.sessionId), ['a']);
            assert.strictEqual(result.grouped.get('Git')?.[0].subtype, 'Branching');
            assert.deepStrictEqual(result.grouped.get('Bugs')?.map(e => e.sessionId), ['b']);
        });

        test('uses sidecar tags and summary when available', () => {
            const session = makeSession('a');
            const cache = new Map<string, SessionMetadata>([
                ['a', { sessionId: 'a', tags: ['x', 'y'], summary: 'User wants to fix the build' }],
            ]);

            const result = buildKbEntriesFromClassifications(
                [session], cache, [{ sessionId: 'a', category: 'Bugs', usedLlm: true }],
            );

            assert.deepStrictEqual(result.entries[0].tags, ['x', 'y']);
            assert.strictEqual(result.entries[0].summary, 'fix the build');
        });

        test('skips classifications for sessions that are not in the batch', () => {
            const result = buildKbEntriesFromClassifications(
                [makeSession('a')], null,
                [
                    { sessionId: 'a', category: 'Git', usedLlm: false },
                    { sessionId: 'missing', category: 'Bugs', usedLlm: false },
                ],
            );
            assert.strictEqual(result.total, 1);
        });
    });

    suite('buildKbEntries â€” shared classification store', () => {
        let dir: string;

        setup(() => {
            dir = path.join(os.tmpdir(), `cw-kbengine-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
            fs.mkdirSync(dir, { recursive: true });
        });
        teardown(() => {
            try { fs.rmSync(dir, { recursive: true }); } catch { /* ignore */ }
        });

        test('reuses classifications from the shared store (no model needed)', async () => {
            const store = new ClassificationStore(dir);
            const session = makeSession('a');
            // The automatic classifier stored this label first.
            await store.importClassifications(
                [{ sessionId: 'a', category: 'Architecture', subcategory: 'Schema Design', usedLlm: true }],
                () => sessionFingerprintFrom(session.updatedAt, session.messages.length),
            );

            const result = await buildKbEntries([session], null, undefined, undefined, true, store);

            assert.strictEqual(result.entries[0].type, 'Architecture');
            assert.strictEqual(result.entries[0].subtype, 'Schema Design');
            assert.strictEqual(result.entries[0].usedLlm, true);
            assert.strictEqual(result.usedLlm, true);
        });

        test('writes an empty history through the shared store without throwing', async () => {
            const store = new ClassificationStore(dir);
            const result = await buildKbEntries([], null, undefined, undefined, true, store);
            assert.strictEqual(result.total, 0);
        });

        test('works without a shared store (full classification path)', async () => {
            const session = makeSession('a');
            // No store → the KB classifies on its own. In tests no model answers,
            // so the entry lands in "Other".
            const result = await buildKbEntries([session], null, undefined, undefined, false);
            assert.strictEqual(result.total, 1);
            assert.strictEqual(result.entries[0].type, 'Other');
            assert.strictEqual(result.usedLlm, false);
        });
    });

    suite('buildKbEntriesFromClassifications — shared structure', () => {

        /** Git (a) → Branching (b); Bugs (c). */
        function folders(): Map<string, SessionFolder> {
            return new Map<string, SessionFolder>([
                ['git', { id: 'git', name: 'Git', parentId: null, sessionIds: ['a'], childFolderIds: ['br'], createdAt: '', updatedAt: '' }],
                ['br', { id: 'br', name: 'Branching', parentId: 'git', sessionIds: ['b'], childFolderIds: [], createdAt: '', updatedAt: '' }],
                ['bugs', { id: 'bugs', name: 'Bugs', parentId: null, sessionIds: ['c'], childFolderIds: [], createdAt: '', updatedAt: '' }],
            ]);
        }

        test('the folder wins over the model label (manual reorganisation is shared)', () => {
            const result = buildKbEntriesFromClassifications(
                [makeSession('a'), makeSession('b'), makeSession('c')], null,
                [
                    { sessionId: 'a', category: 'Proposal', usedLlm: true },
                    { sessionId: 'b', category: 'Proposal', subcategory: 'Old Sub', usedLlm: true },
                    { sessionId: 'c', category: 'Proposal', usedLlm: true },
                ],
                folders(),
            );

            const byId = new Map(result.entries.map(e => [e.sessionId, e]));
            assert.strictEqual(byId.get('a')!.type, 'Git');
            assert.strictEqual(byId.get('a')!.subtype, undefined);
            assert.strictEqual(byId.get('b')!.type, 'Git');
            assert.strictEqual(byId.get('b')!.subtype, 'Branching');
            assert.strictEqual(byId.get('c')!.type, 'Bugs');
            // Both views list the same roots in the same order.
            assert.deepStrictEqual(result.categoryOrder, ['Bugs', 'Git']);
        });

        test('a chat the structure holds nowhere is "Unclassified"', () => {
            const result = buildKbEntriesFromClassifications(
                [makeSession('a'), makeSession('unplaced')], null,
                [
                    { sessionId: 'a', category: 'Git', usedLlm: true },
                    { sessionId: 'unplaced', category: 'Git', usedLlm: true },
                ],
                folders(),
            );

            const unplaced = result.entries.find(e => e.sessionId === 'unplaced')!;
            assert.strictEqual(unplaced.type, 'Unclassified');
            assert.strictEqual(unplaced.subtype, undefined);
            assert.deepStrictEqual(result.categoryOrder, ['Bugs', 'Git', 'Unclassified']);
        });

        test('without a structure the model labels are used as before', () => {
            const result = buildKbEntriesFromClassifications(
                [makeSession('a')], null,
                [{ sessionId: 'a', category: 'Git', subcategory: 'Branching', usedLlm: true }],
            );
            assert.strictEqual(result.entries[0].type, 'Git');
            assert.strictEqual(result.entries[0].subtype, 'Branching');
            assert.strictEqual(result.categoryOrder, undefined);
        });
    });
});
