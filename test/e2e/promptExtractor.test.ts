// test/suite/promptExtractor.test.ts

import * as assert from 'assert';
import { buildPromptLibrary, normalizePromptText } from '../../src/prompts/promptExtractor';
import { SessionIndex } from '../../src/index/sessionIndex';
import { Session, Message } from '../../src/types/index';

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let _idCounter = 0;

function makeMsg(role: 'user' | 'assistant', content: string, timestamp?: string): Message {
    return { id: `msg-${++_idCounter}`, role, content, codeBlocks: [], timestamp };
}

function makeSession(
    id: string,
    messages: Message[],
    workspacePath?: string,
    opts?: { source?: 'copilot' | 'claude'; updatedAt?: string }
): Session {
    return {
        id,
        title: `Session ${id}`,
        source: opts?.source ?? 'copilot',
        workspaceId: 'ws-default',
        workspacePath,
        messages,
        filePath: `/fake/${id}.jsonl`,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: opts?.updatedAt ?? '2024-06-01T00:00:00.000Z',
    };
}

// â”€â”€ normalizePromptText â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

suite('normalizePromptText', () => {
    test('trims leading and trailing whitespace', () => {
        assert.strictEqual(normalizePromptText('  hello  '), 'hello');
    });

    test('collapses internal spaces', () => {
        assert.strictEqual(normalizePromptText('foo   bar'), 'foo bar');
    });

    test('collapses tabs and newlines', () => {
        assert.strictEqual(normalizePromptText('foo\t\nbar'), 'foo bar');
    });

    test('empty string stays empty', () => {
        assert.strictEqual(normalizePromptText(''), '');
    });

    test('whitespace-only string normalizes to empty string', () => {
        assert.strictEqual(normalizePromptText('   \t\n  '), '');
    });
});

// â”€â”€ buildPromptLibrary â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

suite('buildPromptLibrary', () => {
    test('empty index returns empty array', () => {
        const index = new SessionIndex();
        assert.deepStrictEqual(buildPromptLibrary(index), []);
    });

    test('single prompt returns one entry with correct shape', () => {
        const index = new SessionIndex();
        index.upsert(makeSession('s1', [makeMsg('user', 'How do I write a for loop?')], '/projects/my-app'));
        const result = buildPromptLibrary(index);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].text, 'How do I write a for loop?');
        assert.strictEqual(result[0].frequency, 1);
        assert.deepStrictEqual(result[0].sessionIds, ['s1']);
        assert.deepStrictEqual(result[0].projectIds, ['/projects/my-app']);
    });

    test('duplicate prompt in same session: frequency=2, sessionIds deduplicated', () => {
        const index = new SessionIndex();
        index.upsert(makeSession('s-dup', [
            makeMsg('user', 'Explain async/await'),
            makeMsg('assistant', 'Sureâ€¦'),
            makeMsg('user', 'Explain async/await'),
        ]));
        const result = buildPromptLibrary(index);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].frequency, 2);
        assert.strictEqual(result[0].sessionIds.length, 1);
        assert.strictEqual(result[0].sessionIds[0], 's-dup');
    });

    test('duplicate prompt across different sessions: frequency=2, two sessionIds', () => {
        const index = new SessionIndex();
        index.upsert(makeSession('s-a', [makeMsg('user', 'What is a closure?')]));
        index.upsert(makeSession('s-b', [makeMsg('user', 'What is a closure?')]));
        const result = buildPromptLibrary(index);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].frequency, 2);
        assert.strictEqual(result[0].sessionIds.length, 2);
        assert.ok(result[0].sessionIds.includes('s-a'));
        assert.ok(result[0].sessionIds.includes('s-b'));
    });

    test('same prompt from two workspaces: projectIds has 2 entries', () => {
        const index = new SessionIndex();
        index.upsert(makeSession('s-ws1', [makeMsg('user', 'Refactor this class')], '/projects/alpha'));
        index.upsert(makeSession('s-ws2', [makeMsg('user', 'Refactor this class')], '/projects/beta'));
        const result = buildPromptLibrary(index);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].projectIds.length, 2);
        assert.ok(result[0].projectIds.includes('/projects/alpha'));
        assert.ok(result[0].projectIds.includes('/projects/beta'));
    });

    test('prompts differing only in whitespace map to the same entry', () => {
        const index = new SessionIndex();
        index.upsert(makeSession('s-ws', [
            makeMsg('user', 'Fix   the   bug'),
            makeMsg('user', '  Fix\tthe\nbug  '),
        ]));
        const result = buildPromptLibrary(index);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].text, 'Fix the bug');
        assert.strictEqual(result[0].frequency, 2);
    });

    test('results are sorted by frequency descending', () => {
        const index = new SessionIndex();
        index.upsert(makeSession('s1', [
            makeMsg('user', 'alpha'),
            makeMsg('user', 'beta'),
            makeMsg('user', 'beta'),
            makeMsg('user', 'beta'),
            makeMsg('user', 'gamma'),
            makeMsg('user', 'gamma'),
        ]));
        const result = buildPromptLibrary(index);
        assert.strictEqual(result.length, 3);
        assert.strictEqual(result[0].text, 'beta');
        assert.strictEqual(result[0].frequency, 3);
        assert.strictEqual(result[1].text, 'gamma');
        assert.strictEqual(result[1].frequency, 2);
        assert.strictEqual(result[2].text, 'alpha');
        assert.strictEqual(result[2].frequency, 1);
    });

    test('equal frequency entries are sorted alphabetically ascending', () => {
        const index = new SessionIndex();
        index.upsert(makeSession('s-tie', [
            makeMsg('user', 'zebra prompt'),
            makeMsg('user', 'apple prompt'),
            makeMsg('user', 'mango prompt'),
        ]));
        const result = buildPromptLibrary(index);
        assert.strictEqual(result.length, 3);
        assert.strictEqual(result[0].text, 'apple prompt');
        assert.strictEqual(result[1].text, 'mango prompt');
        assert.strictEqual(result[2].text, 'zebra prompt');
    });

    test('firstSeen is the earliest timestamp across duplicates', () => {
        const index = new SessionIndex();
        index.upsert(makeSession('s-ts', [
            makeMsg('user', 'Debug this function', '2024-05-01T10:00:00.000Z'),
            makeMsg('user', 'Debug this function', '2024-03-15T08:00:00.000Z'),
            makeMsg('user', 'Debug this function', '2024-06-20T12:00:00.000Z'),
        ]));
        const result = buildPromptLibrary(index);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].firstSeen, '2024-03-15T08:00:00.000Z');
    });

    test('firstSeen is undefined when no timestamps are present', () => {
        const index = new SessionIndex();
        index.upsert(makeSession('s-nots', [
            makeMsg('user', 'Write a unit test'),
            makeMsg('user', 'Write a unit test'),
        ]));
        const result = buildPromptLibrary(index);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].firstSeen, undefined);
    });

    test('whitespace-only prompt is skipped', () => {
        const index = new SessionIndex();
        index.upsert(makeSession('s-blank', [
            makeMsg('user', '   \t\n  '),
            makeMsg('user', 'valid prompt'),
        ]));
        const result = buildPromptLibrary(index);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].text, 'valid prompt');
    });

    test('session without workspacePath produces empty projectIds', () => {
        const index = new SessionIndex();
        index.upsert(makeSession('s-nowp', [makeMsg('user', 'Optimize this query')]));
        const result = buildPromptLibrary(index);
        assert.strictEqual(result.length, 1);
        assert.deepStrictEqual(result[0].projectIds, []);
    });

    test('assistant messages are not included in the library', () => {
        const index = new SessionIndex();
        index.upsert(makeSession('s-asst', [
            makeMsg('user', 'My prompt'),
            makeMsg('assistant', 'My prompt'),  // same text but assistant role â€” should not count
        ]));
        const result = buildPromptLibrary(index);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].frequency, 1);
    });

    // â”€â”€ sessionMeta â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    test('sessionMeta contains one entry for a single-session prompt', () => {
        const index = new SessionIndex();
        index.upsert(makeSession('s-meta1', [makeMsg('user', 'Explain closures')], '/proj/a'));
        const result = buildPromptLibrary(index);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].sessionMeta.length, 1);
        assert.strictEqual(result[0].sessionMeta[0].sessionId, 's-meta1');
        assert.strictEqual(result[0].sessionMeta[0].title, 'Session s-meta1');
        assert.strictEqual(result[0].sessionMeta[0].source, 'copilot');
    });

    test('sessionMeta contains two entries when prompt spans two sessions', () => {
        const index = new SessionIndex();
        index.upsert(makeSession('s-ma', [makeMsg('user', 'Refactor this module')], '/proj/a'));
        index.upsert(makeSession('s-mb', [makeMsg('user', 'Refactor this module')], '/proj/b'));
        const result = buildPromptLibrary(index);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].sessionMeta.length, 2);
        const ids = result[0].sessionMeta.map(m => m.sessionId).sort();
        assert.deepStrictEqual(ids, ['s-ma', 's-mb']);
    });

    test('sessionMeta deduplicates: same session appearing multiple times has one meta entry', () => {
        const index = new SessionIndex();
        // Same prompt asked 3 times in the same session â†’ only one meta entry
        index.upsert(makeSession('s-dedup', [
            makeMsg('user', 'Optimize this query'),
            makeMsg('user', 'Optimize this query'),
            makeMsg('user', 'Optimize this query'),
        ]));
        const result = buildPromptLibrary(index);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].frequency, 3);
        assert.strictEqual(result[0].sessionMeta.length, 1);
        assert.strictEqual(result[0].sessionMeta[0].sessionId, 's-dedup');
    });

    test('sessionMeta source field reflects session source', () => {
        const index = new SessionIndex();
        index.upsert(makeSession('s-claude', [makeMsg('user', 'Explain monads')], '/proj/x', { source: 'claude' }));
        const result = buildPromptLibrary(index);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].sessionMeta[0].source, 'claude');
    });

    test('sessionMeta updatedAt reflects session updatedAt', () => {
        const index = new SessionIndex();
        const customDate = '2025-03-11T12:00:00.000Z';
        index.upsert(makeSession('s-date', [makeMsg('user', 'Debug this crash')], undefined, { updatedAt: customDate }));
        const result = buildPromptLibrary(index);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].sessionMeta[0].updatedAt, customDate);
    });
});

