// test/suite/copilotParser.test.ts

import * as assert from 'assert';
import * as path from 'path';
import { parseCopilotSession, extractCodeBlocks } from '../../src/parsers/copilot';
import { Message } from '../../src/types/index';

// Resolve fixture path relative to this test file
const FIXTURE_DIR = path.resolve(__dirname, '../../..', 'test', 'fixtures', 'copilot');
const SAMPLE_FIXTURE = path.join(FIXTURE_DIR, 'sample-session.jsonl');

// ---------------------------------------------------------------------------
// parseCopilotSession — happy path
// ---------------------------------------------------------------------------
suite('parseCopilotSession — sample fixture', () => {

    test('returns a ParseResult with no errors', () => {
        const result = parseCopilotSession(SAMPLE_FIXTURE, 'test-workspace-hash');
        assert.strictEqual(result.errors.length, 0, `Unexpected errors: ${result.errors.join(', ')}`);
    });

    test('session id equals the sessionId from the snapshot', () => {
        const { session } = parseCopilotSession(SAMPLE_FIXTURE, 'test-workspace-hash');
        assert.strictEqual(session.id, 'copilot-session-001');
    });

    test('session source is "copilot"', () => {
        const { session } = parseCopilotSession(SAMPLE_FIXTURE, 'test-workspace-hash');
        assert.strictEqual(session.source, 'copilot');
    });

    test('session workspaceId is passed through', () => {
        const { session } = parseCopilotSession(SAMPLE_FIXTURE, 'test-workspace-hash');
        assert.strictEqual(session.workspaceId, 'test-workspace-hash');
    });

    test('session has exactly 4 messages', () => {
        const { session } = parseCopilotSession(SAMPLE_FIXTURE, 'test-workspace-hash');
        assert.strictEqual(session.messages.length, 4);
    });

    test('messages alternate user/assistant/user/assistant', () => {
        const { session } = parseCopilotSession(SAMPLE_FIXTURE, 'test-workspace-hash');
        const roles = session.messages.map((m: Message) => m.role);
        assert.deepStrictEqual(roles, ['user', 'assistant', 'user', 'assistant']);
    });

    test('first user message content matches fixture', () => {
        const { session } = parseCopilotSession(SAMPLE_FIXTURE, 'test-workspace-hash');
        assert.strictEqual(session.messages[0].content, 'How do I center a div in CSS?');
    });

    test('title is first user message truncated to 60 chars', () => {
        const { session } = parseCopilotSession(SAMPLE_FIXTURE, 'test-workspace-hash');
        // First user message is shorter than 60 chars so it appears verbatim
        assert.strictEqual(session.title, 'How do I center a div in CSS?');
    });

    test('user message id equals requestId', () => {
        const { session } = parseCopilotSession(SAMPLE_FIXTURE, 'test-workspace-hash');
        assert.strictEqual(session.messages[0].id, 'req-001');
        assert.strictEqual(session.messages[2].id, 'req-002');
    });

    test('assistant message id equals requestId + "-response"', () => {
        const { session } = parseCopilotSession(SAMPLE_FIXTURE, 'test-workspace-hash');
        assert.strictEqual(session.messages[1].id, 'req-001-response');
        assert.strictEqual(session.messages[3].id, 'req-002-response');
    });

    test('createdAt is an ISO string derived from the snapshot creationDate field', () => {
        const { session } = parseCopilotSession(SAMPLE_FIXTURE, 'test-workspace-hash');
        assert.strictEqual(session.createdAt, new Date(1705312800000).toISOString());
    });

    test('updatedAt is an ISO string derived from the latest request timestamp', () => {
        const { session } = parseCopilotSession(SAMPLE_FIXTURE, 'test-workspace-hash');
        assert.strictEqual(session.updatedAt, new Date(1705312812000).toISOString());
    });

    test('assistant messages contain extracted code blocks', () => {
        const { session } = parseCopilotSession(SAMPLE_FIXTURE, 'test-workspace-hash');
        const asstMsg = session.messages[1]; // first assistant response
        assert.ok(asstMsg.codeBlocks.length > 0, 'Expected at least one code block in assistant message');
    });

    test('extracted code blocks on first assistant message have language "css"', () => {
        const { session } = parseCopilotSession(SAMPLE_FIXTURE, 'test-workspace-hash');
        const asstMsg = session.messages[1];
        for (const block of asstMsg.codeBlocks) {
            assert.strictEqual(block.language, 'css');
        }
    });

    test('optional workspacePath is forwarded to session', () => {
        const { session } = parseCopilotSession(SAMPLE_FIXTURE, 'ws-id', '/home/user/myproject');
        assert.strictEqual(session.workspacePath, '/home/user/myproject');
    });

    test('session filePath equals the provided filePath', () => {
        const { session } = parseCopilotSession(SAMPLE_FIXTURE, 'ws-id');
        assert.strictEqual(session.filePath, SAMPLE_FIXTURE);
    });
});

// ---------------------------------------------------------------------------
// parseCopilotSession — nonexistent file
// ---------------------------------------------------------------------------
suite('parseCopilotSession — nonexistent file', () => {

    const MISSING = path.join(FIXTURE_DIR, 'does-not-exist.jsonl');

    test('errors array is non-empty', () => {
        const { errors } = parseCopilotSession(MISSING, 'ws-id');
        assert.ok(errors.length > 0, 'Expected at least one error for missing file');
    });

    test('session has 0 messages', () => {
        const { session } = parseCopilotSession(MISSING, 'ws-id');
        assert.strictEqual(session.messages.length, 0);
    });

    test('session source is still "copilot"', () => {
        const { session } = parseCopilotSession(MISSING, 'ws-id');
        assert.strictEqual(session.source, 'copilot');
    });

    test('session id falls back to filename without extension', () => {
        const { session } = parseCopilotSession(MISSING, 'ws-id');
        assert.strictEqual(session.id, 'does-not-exist');
    });
});

// ---------------------------------------------------------------------------
// parseCopilotSession — incremental multi-turn (each turn added via separate kind=2 patch)
// ---------------------------------------------------------------------------
// This exercises the pattern where VS Code writes one 1-element kind=2 requests
// patch per turn instead of a single patch with all turns.  The parser must
// APPEND each new turn rather than replace the entire requests array.
suite('parseCopilotSession — multi-turn incremental fixture', () => {

    const MULTI_TURN_FIXTURE = path.join(FIXTURE_DIR, 'multi-turn-incremental.jsonl');

    test('returns no errors', () => {
        const { errors } = parseCopilotSession(MULTI_TURN_FIXTURE, 'ws-id');
        assert.strictEqual(errors.length, 0, `Unexpected errors: ${errors.join(', ')}`);
    });

    test('session has exactly 6 messages (3 turns × user+assistant)', () => {
        const { session } = parseCopilotSession(MULTI_TURN_FIXTURE, 'ws-id');
        assert.strictEqual(session.messages.length, 6);
    });

    test('messages alternate user/assistant for all 3 turns', () => {
        const { session } = parseCopilotSession(MULTI_TURN_FIXTURE, 'ws-id');
        const roles = session.messages.map((m: Message) => m.role);
        assert.deepStrictEqual(roles, ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    });

    test('first user message is correct', () => {
        const { session } = parseCopilotSession(MULTI_TURN_FIXTURE, 'ws-id');
        assert.strictEqual(session.messages[0].content, 'What is TypeScript?');
    });

    test('second user message is correct', () => {
        const { session } = parseCopilotSession(MULTI_TURN_FIXTURE, 'ws-id');
        assert.strictEqual(session.messages[2].content, 'How do I install it?');
    });

    test('third user message is correct', () => {
        const { session } = parseCopilotSession(MULTI_TURN_FIXTURE, 'ws-id');
        assert.strictEqual(session.messages[4].content, 'How do I compile a file?');
    });

    test('third assistant response is correct', () => {
        const { session } = parseCopilotSession(MULTI_TURN_FIXTURE, 'ws-id');
        assert.strictEqual(session.messages[5].content, 'Run: tsc yourfile.ts');
    });

    test('custom title is used as session title', () => {
        const { session } = parseCopilotSession(MULTI_TURN_FIXTURE, 'ws-id');
        assert.strictEqual(session.title, 'Multi-turn incremental test');
    });
});

// ---------------------------------------------------------------------------
// extractCodeBlocks — with code blocks
// ---------------------------------------------------------------------------
suite('extractCodeBlocks — content with 2 fenced code blocks', () => {

    const CONTENT = [
        'Here is some TypeScript:',
        '```typescript',
        'const x: number = 42;',
        'console.log(x);',
        '```',
        'And some Python:',
        '```python',
        'x = 42',
        'print(x)',
        '```',
        'End.',
    ].join('\n');

    test('returns exactly 2 code blocks', () => {
        const blocks = extractCodeBlocks(CONTENT, 'session-1', 0);
        assert.strictEqual(blocks.length, 2);
    });

    test('first block has language "typescript"', () => {
        const blocks = extractCodeBlocks(CONTENT, 'session-1', 0);
        assert.strictEqual(blocks[0].language, 'typescript');
    });

    test('first block content is trimmed and correct', () => {
        const blocks = extractCodeBlocks(CONTENT, 'session-1', 0);
        assert.strictEqual(blocks[0].content, 'const x: number = 42;\nconsole.log(x);');
    });

    test('second block has language "python"', () => {
        const blocks = extractCodeBlocks(CONTENT, 'session-1', 0);
        assert.strictEqual(blocks[1].language, 'python');
    });

    test('second block content is trimmed and correct', () => {
        const blocks = extractCodeBlocks(CONTENT, 'session-1', 0);
        assert.strictEqual(blocks[1].content, 'x = 42\nprint(x)');
    });

    test('sessionId is forwarded to each block', () => {
        const blocks = extractCodeBlocks(CONTENT, 'session-42', 3);
        for (const block of blocks) {
            assert.strictEqual(block.sessionId, 'session-42');
        }
    });

    test('messageIndex is forwarded to each block', () => {
        const blocks = extractCodeBlocks(CONTENT, 'session-1', 7);
        for (const block of blocks) {
            assert.strictEqual(block.messageIndex, 7);
        }
    });
});

// ---------------------------------------------------------------------------
// extractCodeBlocks — no code blocks
// ---------------------------------------------------------------------------
suite('extractCodeBlocks — content with no code blocks', () => {

    test('returns an empty array for plain text', () => {
        const blocks = extractCodeBlocks('Just some plain text, no fences.', 's1', 0);
        assert.deepStrictEqual(blocks, []);
    });

    test('returns an empty array for empty string', () => {
        const blocks = extractCodeBlocks('', 's1', 0);
        assert.deepStrictEqual(blocks, []);
    });

    test('returns an empty array when backticks appear inline but not as fences', () => {
        const blocks = extractCodeBlocks('Use `const` for constants.', 's1', 0);
        assert.deepStrictEqual(blocks, []);
    });
});
