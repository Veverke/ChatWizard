// test/suite/claudeParser.test.ts

import * as assert from 'assert';
import * as path from 'path';
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
