// test/suite/claudeParser.test.ts

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
    parseClaudeSession,
    extractTextContent,
    extractCodeBlocks,
} from '../../src/parsers/claude';

const FIXTURES_DIR = path.resolve(__dirname, '../../..', 'test', 'fixtures', 'claude');

suite('Claude Parser — parseClaudeSession', () => {
    test('parses sample-session.jsonl correctly', () => {
        const filePath = path.join(FIXTURES_DIR, 'sample-session.jsonl');
        const { session, errors } = parseClaudeSession(filePath);

        // Source must be 'claude'
        assert.strictEqual(session.source, 'claude');

        // Should have exactly 4 messages (2 human, 2 assistant)
        assert.strictEqual(session.messages.length, 4);

        // Roles should alternate: user, assistant, user, assistant
        assert.strictEqual(session.messages[0].role, 'user');
        assert.strictEqual(session.messages[1].role, 'assistant');
        assert.strictEqual(session.messages[2].role, 'user');
        assert.strictEqual(session.messages[3].role, 'assistant');

        // Title should come from the summary line
        assert.strictEqual(
            session.title,
            'Discussion about implementing a binary search algorithm in TypeScript'
        );

        // workspacePath comes from the cwd of the first human entry
        assert.strictEqual(session.workspacePath, '/home/user/projects/myapp');

        // Session id comes from the sessionId field in the JSONL entries
        assert.strictEqual(session.id, 'session-claude-001');

        // workspaceId equals the session id for Claude sessions
        assert.strictEqual(session.workspaceId, session.id);

        // No parse errors
        assert.strictEqual(errors.length, 0);
    });

    test('parses malformed-session.jsonl and reports one error', () => {
        const filePath = path.join(FIXTURES_DIR, 'malformed-session.jsonl');
        const { session, errors } = parseClaudeSession(filePath);

        // Exactly one line fails to parse
        assert.strictEqual(errors.length, 1);

        // The two valid human entries should be parsed (the truncated assistant entry is skipped)
        assert.strictEqual(session.messages.length, 2);

        // Both valid messages are user messages
        assert.strictEqual(session.messages[0].role, 'user');
        assert.strictEqual(session.messages[1].role, 'user');
    });

    test('handles a nonexistent file gracefully', () => {
        const filePath = path.join(FIXTURES_DIR, 'does-not-exist.jsonl');
        const { session, errors } = parseClaudeSession(filePath);

        // Must report an error rather than throw
        assert.ok(errors.length > 0, 'Expected at least one error for missing file');

        // No messages parsed from a file that does not exist
        assert.strictEqual(session.messages.length, 0);
    });
});

suite('Claude Parser — extractTextContent', () => {
    test('joins only text parts and skips non-text parts', () => {
        const parts = [
            { type: 'text', text: 'Hello, ' },
            { type: 'tool_use', id: 'tool-1', name: 'bash', input: {} },
            { type: 'text', text: 'world!' },
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'output' },
        ] as Array<{ type: string; text?: string }>;

        const result = extractTextContent(parts);

        assert.strictEqual(result, 'Hello, world!');
    });

    test('returns empty string for empty array', () => {
        assert.strictEqual(extractTextContent([]), '');
    });

    test('returns empty string when no text parts present', () => {
        const parts = [{ type: 'tool_use' }] as Array<{ type: string; text?: string }>;
        assert.strictEqual(extractTextContent(parts), '');
    });
});

suite('Claude Parser — extractCodeBlocks', () => {
    test('extracts a single TypeScript code block with correct language and content', () => {
        const content = [
            'Here is an example:',
            '```typescript',
            'const x: number = 42;',
            'console.log(x);',
            '```',
            'End of example.',
        ].join('\n');

        const blocks = extractCodeBlocks(content, 'session-test', 0);

        assert.strictEqual(blocks.length, 1);
        assert.strictEqual(blocks[0].language, 'typescript');
        assert.strictEqual(blocks[0].content, 'const x: number = 42;\nconsole.log(x);');
        assert.strictEqual(blocks[0].sessionId, 'session-test');
        assert.strictEqual(blocks[0].messageIndex, 0);
    });

    test('extracts multiple code blocks from one message', () => {
        const content = [
            '```python',
            'print("hello")',
            '```',
            'And also:',
            '```bash',
            'echo hello',
            '```',
        ].join('\n');

        const blocks = extractCodeBlocks(content, 'session-multi', 2);

        assert.strictEqual(blocks.length, 2);
        assert.strictEqual(blocks[0].language, 'python');
        assert.strictEqual(blocks[1].language, 'bash');
        assert.strictEqual(blocks[1].messageIndex, 2);
    });

    test('extracts a code block with no language label', () => {
        const content = '```\nsome plain code\n```';
        const blocks = extractCodeBlocks(content, 'session-plain', 0);

        assert.strictEqual(blocks.length, 1);
        assert.strictEqual(blocks[0].language, '');
        assert.strictEqual(blocks[0].content, 'some plain code');
    });

    test('returns empty array when no code blocks present', () => {
        const blocks = extractCodeBlocks('Just plain text, no fences.', 'session-empty', 0);
        assert.strictEqual(blocks.length, 0);
    });
});

// ---------------------------------------------------------------------------
// Claude Parser — edge cases for branch coverage
// ---------------------------------------------------------------------------

suite('Claude Parser — branch coverage edge cases', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-claude-test-'));
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeJsonl(filename: string, lines: object[]): string {
        const filePath = path.join(tmpDir, filename);
        fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n'), 'utf-8');
        return filePath;
    }

    test('content as string (not array) is treated as text', () => {
        const filePath = writeJsonl('string-content.jsonl', [
            { type: 'human', uuid: 'u1', sessionId: 'sess1', timestamp: '2024-01-01T00:00:00Z', message: { role: 'user', content: 'Hello world' } },
            { type: 'assistant', uuid: 'a1', sessionId: 'sess1', timestamp: '2024-01-01T00:01:00Z', message: { role: 'assistant', model: 'claude-3', content: 'Hi there!' } },
        ]);
        const { session, errors } = parseClaudeSession(filePath);
        assert.strictEqual(errors.length, 0);
        assert.strictEqual(session.messages.length, 2);
        assert.strictEqual(session.messages[0].content, 'Hello world');
        assert.strictEqual(session.messages[1].content, 'Hi there!');
    });

    test('model synthetic is excluded from model field', () => {
        const filePath = writeJsonl('synthetic-model.jsonl', [
            { type: 'human', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', message: { role: 'user', content: 'Hello' } },
            { type: 'assistant', uuid: 'a1', timestamp: '2024-01-01T00:01:00Z', message: { role: 'assistant', model: '<synthetic>', content: 'Hi' } },
            { type: 'assistant', uuid: 'a2', timestamp: '2024-01-01T00:02:00Z', message: { role: 'assistant', model: 'claude-3-opus', content: 'Real reply' } },
        ]);
        const { session } = parseClaudeSession(filePath);
        // synthetic model should be skipped; real model should be used
        assert.strictEqual(session.model, 'claude-3-opus');
    });

    test('entry without timestamp does not set createdAt/updatedAt', () => {
        const filePath = writeJsonl('no-timestamp.jsonl', [
            { type: 'human', uuid: 'u1', message: { role: 'user', content: 'No timestamp here' } },
        ]);
        const { session } = parseClaudeSession(filePath);
        assert.strictEqual(session.messages.length, 1);
        // createdAt and updatedAt should still be set (from file stat fallback)
        assert.ok(session.createdAt);
        assert.ok(session.updatedAt);
    });

    test('title derived from first user message when no summary', () => {
        const filePath = writeJsonl('no-summary.jsonl', [
            { type: 'human', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', message: { role: 'user', content: 'What is the capital of France?' } },
            { type: 'assistant', uuid: 'a1', timestamp: '2024-01-01T00:01:00Z', message: { role: 'assistant', content: 'Paris.' } },
        ]);
        const { session } = parseClaudeSession(filePath);
        assert.ok(session.title.includes('What is the capital'));
    });

    test('title truncated to 120 chars when user message is very long', () => {
        const longMsg = 'A'.repeat(200);
        const filePath = writeJsonl('long-title.jsonl', [
            { type: 'human', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', message: { role: 'user', content: longMsg } },
        ]);
        const { session } = parseClaudeSession(filePath);
        assert.ok(session.title.length <= 125, `Title too long: ${session.title.length}`);
    });

    test('oversized line is handled with skipped placeholder', () => {
        const oversizedLine = JSON.stringify({
            type: 'human', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z',
            message: { role: 'user', content: 'A'.repeat(50) },
        });
        // parseClaudeSession with small maxLineChars
        const filePath = writeJsonl('oversized.jsonl', []);
        fs.writeFileSync(filePath, oversizedLine + '\n', 'utf-8');
        const { session, errors } = parseClaudeSession(filePath, 50);
        assert.ok(errors.length > 0, 'Expected at least one error for oversized line');
        // The skipped placeholder message should be added
        assert.strictEqual(session.messages.length, 1);
        assert.strictEqual(session.messages[0].skipped, true);
    });

    test('entry without uuid uses fallback id', () => {
        const filePath = writeJsonl('no-uuid.jsonl', [
            { type: 'human', timestamp: '2024-01-01T00:00:00Z', message: { role: 'user', content: 'Hello' } },
        ]);
        const { session } = parseClaudeSession(filePath);
        assert.strictEqual(session.messages.length, 1);
        assert.ok(session.messages[0].id, 'id should be defined');
        // id should be based on resolvedId, not undefined
        assert.ok(!session.messages[0].id.includes('undefined'));
    });

    test('tool-only assistant message (no visible text) is skipped', () => {
        const filePath = writeJsonl('tool-only.jsonl', [
            { type: 'human', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', message: { role: 'user', content: 'Do something' } },
            { type: 'assistant', uuid: 'a1', timestamp: '2024-01-01T00:01:00Z', message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'tool-1', name: 'bash', input: {} }],
            }},
        ]);
        const { session } = parseClaudeSession(filePath);
        // Tool-only assistant message should be skipped
        assert.strictEqual(session.messages.length, 1);
        assert.strictEqual(session.messages[0].role, 'user');
    });

    test('entry type=user (alias for human) is parsed as user role', () => {
        const filePath = writeJsonl('type-user.jsonl', [
            { type: 'user', uuid: 'u1', sessionId: 'sess2', cwd: '/my/project', timestamp: '2024-01-01T00:00:00Z', message: { role: 'user', content: 'Using user type' } },
        ]);
        const { session } = parseClaudeSession(filePath);
        assert.strictEqual(session.messages.length, 1);
        assert.strictEqual(session.messages[0].role, 'user');
        assert.strictEqual(session.workspacePath, '/my/project');
    });

    test('oversized assistant line creates assistant skipped placeholder', () => {
        // An oversized line without "human" or "user" type → typeMatch is null → placeholderRole = 'assistant'
        // Create a normal human line that fits within 500-char limit, and an oversized assistant line
        const normalLine = JSON.stringify({
            type: 'human', uuid: 'u1', sessionId: 'sess-oa', timestamp: '2024-01-01T00:00:00Z',
            message: { role: 'user', content: 'Q' },
        });
        // Build an oversized assistant line (>500 chars) — use a large content pad
        const oversizedLine = '{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":"' + 'B'.repeat(500) + '"}}';
        const filePath = writeJsonl('oversized-asst.jsonl', []);
        fs.writeFileSync(filePath, normalLine + '\n' + oversizedLine + '\n', 'utf-8');
        const { session, errors } = parseClaudeSession(filePath, 500);
        assert.ok(errors.length > 0, 'Expected error for oversized line');
        const skipped = session.messages.find(m => m.skipped);
        assert.ok(skipped, 'Should have a skipped placeholder');
        assert.strictEqual(skipped!.role, 'assistant');
    });

    test('assistant entry with model = <synthetic> is not used for model field', () => {
        const filePath = writeJsonl('synthetic-model.jsonl', [
            { type: 'human', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', message: { role: 'user', content: 'Hello' } },
            { type: 'assistant', uuid: 'a1', timestamp: '2024-01-01T00:01:00Z', message: { role: 'assistant', model: '<synthetic>', content: 'Reply' } },
        ]);
        const { session } = parseClaudeSession(filePath);
        assert.strictEqual(session.model, undefined, 'synthetic model should not be set');
    });

    test('string content in message is treated as text', () => {
        // rawContent is a string (not array) → uses rawContentStr path
        const filePath = writeJsonl('string-content.jsonl', [
            { type: 'human', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', message: { role: 'user', content: 'Direct string content' } },
        ]);
        const { session } = parseClaudeSession(filePath);
        assert.strictEqual(session.messages.length, 1);
        assert.strictEqual(session.messages[0].content, 'Direct string content');
    });

    test('title uses raw content fallback when first line is empty', () => {
        // First user message starts with newline so first line is empty
        const filePath = writeJsonl('empty-first-line.jsonl', [
            { type: 'human', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', message: { role: 'user', content: '\nActual content after newline' } },
        ]);
        const { session } = parseClaudeSession(filePath);
        assert.ok(session.title, 'title should not be empty');
    });

    test('no messages at all: title falls back to resolvedId', () => {
        // All entries are tool-only (empty content) or unsupported type
        const filePath = writeJsonl('no-text-messages.jsonl', [
            { type: 'human', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', message: { role: 'user', content: '' } },
        ]);
        const { session } = parseClaudeSession(filePath);
        // No messages means title falls back to resolvedId
        assert.ok(session.title.length > 0);
    });

    test('sessionId from human entry sets resolvedId', () => {
        const filePath = writeJsonl('session-id.jsonl', [
            { type: 'human', uuid: 'u1', sessionId: 'my-session-id', timestamp: '2024-01-01T00:00:00Z', message: { role: 'user', content: 'Hello' } },
        ]);
        const { session } = parseClaudeSession(filePath);
        assert.strictEqual(session.id, 'my-session-id');
    });

    test('code block with no language tag uses empty string', () => {
        // A code block with no language specifier: ```\ncode\n```
        const filePath = writeJsonl('unnamed-block.jsonl', [
            { type: 'human', uuid: 'u1', timestamp: '2024-01-01T00:00:00Z', message: { role: 'user', content: 'Look:\n```\nconsole.log("hi")\n```' } },
        ]);
        const { session } = parseClaudeSession(filePath);
        assert.ok(session.messages.length >= 1);
        const blocks = session.messages[0].codeBlocks;
        assert.ok(blocks.length >= 1, 'Should have extracted code block');
        assert.strictEqual(blocks[0].language, '');
    });
});
