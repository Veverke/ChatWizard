/**
 * test/unit/kbEngine.test.ts
 *
 * Unit tests for kbEngine — shared KB engine functions.
 */

import * as assert from 'assert';
import { mergeIntoResult, removeFromResult, cleanSummary } from '../../src/analytics/kbEngine.js';
import type { KbEntry, KbEntryType } from '../../src/types/kb.js';

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
});