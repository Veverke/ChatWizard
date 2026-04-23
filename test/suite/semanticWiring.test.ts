// test/suite/semanticWiring.test.ts
//
// Unit tests for the semantic search wiring helpers exported from extension.ts.
//
// The wiring inside activate() depends heavily on VS Code APIs (commands, config,
// status bar, etc.) and is verified through the Extension Development Host manual
// testing steps documented in docs/work-plan-semantic-search.md Phase 5.
//
// What CAN be unit-tested here is the pure `buildSemanticText` helper, which is
// the only exported, dependency-free function produced by the wiring phase.

import * as assert from 'assert';
import { buildSemanticText } from '../../src/extension';
import { Session, Message } from '../../src/types/index';
import { SEMANTIC_MAX_CHARS } from '../../src/search/semanticContracts';

// ── Fixture builders ───────────────────────────────────────────────────────

let _idCounter = 0;

function makeMessage(role: 'user' | 'assistant', content: string): Message {
    return { id: `msg-${++_idCounter}`, role, content, codeBlocks: [] };
}

function makeSession(overrides: Partial<Session> & { messages?: Message[] } = {}): Session {
    return {
        id:          overrides.id          ?? 'sess-1',
        title:       overrides.title       ?? 'Test Session',
        source:      overrides.source      ?? 'copilot',
        workspaceId: overrides.workspaceId ?? 'ws-default',
        messages:    overrides.messages    ?? [],
        filePath:    overrides.filePath    ?? '/fake/sess-1.jsonl',
        createdAt:   overrides.createdAt   ?? '2025-01-01T00:00:00.000Z',
        updatedAt:   overrides.updatedAt   ?? '2025-06-01T00:00:00.000Z',
    };
}

// ── buildSemanticText ──────────────────────────────────────────────────────

suite('buildSemanticText', () => {
    test('includes the session title', () => {
        const session = makeSession({ title: 'Authentication patterns' });
        const text = buildSemanticText(session);
        assert.ok(text.includes('Authentication patterns'), `text: ${text.slice(0, 200)}`);
    });

    test('includes user message content', () => {
        const session = makeSession({
            messages: [makeMessage('user', 'How do I implement JWT auth?')],
        });
        const text = buildSemanticText(session);
        assert.ok(text.includes('How do I implement JWT auth?'));
    });

    test('includes assistant message content', () => {
        const session = makeSession({
            messages: [
                makeMessage('user', 'What is React?'),
                makeMessage('assistant', 'React is a UI library built by Meta.'),
            ],
        });
        const text = buildSemanticText(session);
        assert.ok(text.includes('React is a UI library built by Meta.'));
    });

    test('title and messages are separated by newlines', () => {
        const session = makeSession({
            title: 'My title',
            messages: [makeMessage('user', 'First message')],
        });
        const text = buildSemanticText(session);
        assert.ok(text.includes('My title\nFirst message'), `text: ${JSON.stringify(text)}`);
    });

    test('multiple messages are joined with newlines', () => {
        const session = makeSession({
            title: 'T',
            messages: [
                makeMessage('user', 'Line A'),
                makeMessage('assistant', 'Line B'),
                makeMessage('user', 'Line C'),
            ],
        });
        const text = buildSemanticText(session);
        assert.ok(text.includes('Line A\nLine B\nLine C'));
    });

    test('result for empty messages is just the title', () => {
        const session = makeSession({ title: 'Just the title', messages: [] });
        const text = buildSemanticText(session);
        assert.strictEqual(text, 'Just the title');
    });

    test('truncates to SEMANTIC_MAX_CHARS when content is long', () => {
        const longContent = 'x'.repeat(SEMANTIC_MAX_CHARS * 2);
        const session = makeSession({ messages: [makeMessage('user', longContent)] });
        const text = buildSemanticText(session);
        assert.strictEqual(text.length, SEMANTIC_MAX_CHARS);
    });

    test('does not truncate when content is exactly SEMANTIC_MAX_CHARS', () => {
        // title is "Test Session" (12 chars) + "\n" + remaining fill
        const fillLen = SEMANTIC_MAX_CHARS - 'Test Session'.length - 1;
        const session = makeSession({ messages: [makeMessage('user', 'x'.repeat(fillLen))] });
        const text = buildSemanticText(session);
        assert.strictEqual(text.length, SEMANTIC_MAX_CHARS);
    });

    test('does not truncate short content', () => {
        const session = makeSession({
            title: 'Short',
            messages: [makeMessage('user', 'Brief')],
        });
        const text = buildSemanticText(session);
        assert.strictEqual(text, 'Short\nBrief');
    });

    test('returned string is a string type', () => {
        const text = buildSemanticText(makeSession());
        assert.strictEqual(typeof text, 'string');
    });

    test('handles session with no title gracefully', () => {
        const session = makeSession({ title: '', messages: [makeMessage('user', 'content')] });
        const text = buildSemanticText(session);
        // '\n' + 'content' when title is empty
        assert.ok(text.includes('content'));
    });

    test('truncated output is always a prefix of the full text', () => {
        const longContent = 'a'.repeat(SEMANTIC_MAX_CHARS * 3);
        const session = makeSession({
            title: 'Title',
            messages: [makeMessage('user', longContent)],
        });
        const full = ['Title', longContent].join('\n');
        const text = buildSemanticText(session);
        assert.strictEqual(text, full.slice(0, SEMANTIC_MAX_CHARS));
    });

    test('session with many short messages all appear before truncation', () => {
        const messages = Array.from({ length: 5 }, (_, i) =>
            makeMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`)
        );
        const session = makeSession({ title: 'Multi', messages });
        const text = buildSemanticText(session);
        // All 5 messages together with title fit well under 2048 chars
        for (let i = 0; i < 5; i++) {
            assert.ok(text.includes(`Message ${i}`), `Missing "Message ${i}" in text`);
        }
    });
});
