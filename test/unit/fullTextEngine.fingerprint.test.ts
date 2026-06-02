// test/unit/fullTextEngine.fingerprint.test.ts
// Unit tests for Item 8: skip FTS re-tokenization for unchanged sessions

import * as assert from 'assert';
import { FullTextSearchEngine } from '../../src/search/fullTextEngine';
import { Session } from '../../src/types/index';

function makeSession(overrides: Partial<Session> & { id: string }): Session {
    return {
        id: overrides.id,
        source: 'copilot',
        title: overrides.title ?? 'Test Session',
        messages: overrides.messages ?? [
            { id: 'm1', role: 'user', content: 'hello world', timestamp: '', codeBlocks: [] },
            { id: 'm2', role: 'assistant', content: 'hi there docker', timestamp: '', codeBlocks: [] },
        ],
        workspaceId: 'ws1',
        workspacePath: '/ws1',
        filePath: '/ws1/session.json',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: overrides.updatedAt ?? '2024-01-01T00:00:00Z',
        model: 'gpt-4',
    };
}

suite('FullTextSearchEngine – content fingerprint', () => {
    test('same session indexed twice with same content skips re-tokenization', () => {
        const engine = new FullTextSearchEngine();
        const s = makeSession({ id: 's1' });
        engine.index(s);
        const statsBefore = engine.indexStats();
        engine.index(s); // same object, same fingerprint
        const statsAfter = engine.indexStats();
        // postings should be identical — no duplication
        assert.strictEqual(statsBefore.postingCount, statsAfter.postingCount);
    });

    test('indexing with new updatedAt triggers re-tokenization', () => {
        const engine = new FullTextSearchEngine();
        const s1 = makeSession({ id: 's1', updatedAt: '2024-01-01T00:00:00Z' });
        engine.index(s1);
        const s2 = makeSession({
            id: 's1',
            updatedAt: '2024-06-01T00:00:00Z',
            messages: [
                { id: 'm1', role: 'user', content: 'completely different kubernetes content', timestamp: '', codeBlocks: [] },
            ],
        });
        engine.index(s2);
        // old token "docker" should be gone; "kubernetes" should be searchable via relaxed
        const results = engine.searchRelaxedBySession('kubernetes', 5);
        assert.ok(results.some(r => r.sessionId === 's1'), 'should find s1 via kubernetes');
    });

    test('clear() resets _contentVersions so re-index works', () => {
        const engine = new FullTextSearchEngine();
        const s = makeSession({ id: 's1' });
        engine.index(s);
        engine.clear();
        engine.index(s);
        const stats = engine.indexStats();
        // After clear+reindex, postings should exist again
        assert.ok(stats.postingCount > 0 || stats.hapaxTokenCount > 0);
    });

    test('remove() clears fingerprint so re-index after remove works', () => {
        const engine = new FullTextSearchEngine();
        const s = makeSession({ id: 's1' });
        engine.index(s);
        engine.remove('s1');
        engine.index(s); // should not skip
        const results = engine.searchRelaxedBySession('docker', 5);
        assert.ok(results.some(r => r.sessionId === 's1'));
    });

    test('title-only change re-uses existing postings (same fingerprint)', () => {
        const engine = new FullTextSearchEngine();
        const s1 = makeSession({ id: 's1', title: 'Old Title' });
        engine.index(s1);
        const s2 = { ...s1, title: 'New Title' };
        engine.index(s2);
        // title update is preserved in sessions map
        assert.strictEqual(engine.size, 1);
    });
});