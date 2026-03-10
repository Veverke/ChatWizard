// test/suite/markdownSerializer.test.ts

import * as assert from 'assert';
import { serializeSession, serializeSessions } from '../../src/export/markdownSerializer';
import { Session, Message } from '../../src/types/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _id = 0;
function msg(role: 'user' | 'assistant', content: string): Message {
    return { id: `m${++_id}`, role, content, codeBlocks: [], timestamp: undefined };
}

function makeSession(overrides: Partial<Session> & { id: string }): Session {
    return {
        title: 'Test Session',
        source: 'claude',
        workspaceId: 'ws1',
        workspacePath: '/home/user/project',
        messages: [],
        filePath: `/tmp/${overrides.id}.jsonl`,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-15T10:30:00.000Z',
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('markdownSerializer', () => {

    test('empty session produces metadata header with no message sections', () => {
        const s = makeSession({ id: 'empty', messages: [] });
        const md = serializeSession(s);
        assert.ok(md.startsWith('# Test Session'), 'should start with H1 title');
        assert.ok(md.includes('**Source:** Claude Code'), 'should include source');
        assert.ok(md.includes('**Updated:** 2026-01-15 10:30'), 'should include date');
        assert.ok(!md.includes('## '), 'should have no H2 headings for empty session');
        assert.ok(!md.includes('### Response'), 'should have no H3 headings for empty session');
    });

    test('single user message produces H2 heading and content', () => {
        const s = makeSession({ id: 's1', messages: [msg('user', 'How do I sort an array?')] });
        const md = serializeSession(s);
        assert.ok(md.includes('## How do I sort an array?'), 'should have H2 with user content');
        assert.ok(md.includes('How do I sort an array?'), 'full content should appear');
    });

    test('single assistant message produces H3 Response heading and content', () => {
        const s = makeSession({ id: 's2', messages: [msg('assistant', 'Use Array.sort().')] });
        const md = serializeSession(s);
        assert.ok(md.includes('### Response'), 'should have H3 Response heading');
        assert.ok(md.includes('Use Array.sort().'), 'assistant content should appear');
    });

    test('user + assistant pair: H2 before user, H3 before assistant, with --- separator', () => {
        const s = makeSession({
            id: 's3',
            messages: [
                msg('user', 'Explain closures'),
                msg('assistant', 'A closure captures variables from outer scope.'),
            ],
        });
        const md = serializeSession(s);
        const h2Pos = md.indexOf('## Explain closures');
        const h3Pos = md.indexOf('### Response');
        const sepPos = md.indexOf('---');
        assert.ok(h2Pos > -1, 'H2 should exist');
        assert.ok(h3Pos > h2Pos, 'H3 should come after H2');
        assert.ok(sepPos > -1, '--- separator should exist');
        assert.ok(sepPos < h2Pos, '--- should precede H2');
    });

    test('fenced code block in message content appears verbatim', () => {
        const content = 'Here is the code:\n\n```typescript\nconst x = 1;\n```\n\nDone.';
        const s = makeSession({ id: 's4', messages: [msg('assistant', content)] });
        const md = serializeSession(s);
        assert.ok(md.includes('```typescript\nconst x = 1;\n```'), 'code fence should be preserved verbatim');
    });

    test('long first line in user message is truncated to 120 chars with ellipsis', () => {
        const longLine = 'A'.repeat(130);
        const s = makeSession({ id: 's5', messages: [msg('user', longLine)] });
        const md = serializeSession(s);
        const heading = `## ${'A'.repeat(120)}…`;
        assert.ok(md.includes(heading), 'heading should be truncated at 120 chars with ellipsis');
    });

    test('empty content messages are skipped', () => {
        const s = makeSession({
            id: 's6',
            messages: [
                msg('user', '   '),          // whitespace-only — skip
                msg('assistant', 'Hello'),
            ],
        });
        const md = serializeSession(s);
        assert.ok(!md.includes('## '), 'empty user message should not produce H2');
        assert.ok(md.includes('### Response'), 'non-empty assistant message should appear');
    });

    test('model line is included when session.model is set', () => {
        const s = makeSession({ id: 's7', model: 'claude-sonnet-4-6', messages: [] });
        const md = serializeSession(s);
        assert.ok(md.includes('**Model:** claude-sonnet-4-6'), 'model should appear in metadata');
    });

    test('model line is absent when session.model is undefined', () => {
        const s = makeSession({ id: 's8', model: undefined, messages: [] });
        const md = serializeSession(s);
        assert.ok(!md.includes('**Model:**'), 'model line should be absent when undefined');
    });

    test('serializeSessions combined mode includes TOC and all session titles', () => {
        const s1 = makeSession({ id: 'c1', title: 'Session Alpha', messages: [] });
        const s2 = makeSession({ id: 'c2', title: 'Session Beta', messages: [] });
        const md = serializeSessions([s1, s2], 'combined');
        assert.ok(md.startsWith('# ChatWizard Export'), 'should start with top-level heading');
        assert.ok(md.includes('Session Alpha'), 'should contain first session title');
        assert.ok(md.includes('Session Beta'), 'should contain second session title');
        // Both session H1s should appear
        assert.ok(md.includes('# Session Alpha'), 'session 1 H1 should appear');
        assert.ok(md.includes('# Session Beta'), 'session 2 H1 should appear');
    });
});
