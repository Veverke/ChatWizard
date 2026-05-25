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

// ---------------------------------------------------------------------------
// parseCopilotSession — edge cases for branch coverage
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as os from 'os';

suite('parseCopilotSession — branch coverage edge cases', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-copilot-test-'));
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeJsonl(filename: string, lines: object[]): string {
        const filePath = path.join(tmpDir, filename);
        fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n'), 'utf-8');
        return filePath;
    }

    function makeSnapshot(state: Record<string, unknown>) {
        return { kind: 0, v: state };
    }

    function makePatch(k: unknown[], v: unknown, kind: number = 1) {
        return { kind, k, v };
    }

    function makeTurn(requestId: string, userText: string, aiText: string, timestamp?: number) {
        return {
            requestId,
            kind: null,
            timestamp,
            message: { text: userText },
            response: [{ value: aiText }],
        };
    }

    test('oversized line is skipped with error', () => {
        const bigLine = JSON.stringify(makeSnapshot({ sessionId: 'sess1', requests: [] })) + 'X'.repeat(5000);
        const normalLine = JSON.stringify(makeSnapshot({ sessionId: 'sess2', requests: [makeTurn('r1', 'Hi', 'Hello')] }));
        const filePath = path.join(tmpDir, 'oversized.jsonl');
        fs.writeFileSync(filePath, bigLine + '\n' + normalLine + '\n', 'utf-8');
        const { errors } = parseCopilotSession(filePath, 'ws1');
        assert.ok(errors.length > 0, 'Expected at least one error for oversized line');
    });

    test('no snapshot (kind:0) returns error', () => {
        const filePath = writeJsonl('no-snapshot.jsonl', [
            makePatch(['requests'], [makeTurn('r1', 'Hi', 'Hello')]),
        ]);
        const { errors } = parseCopilotSession(filePath, 'ws1');
        assert.ok(errors.some(e => e.includes('No initial state snapshot')));
    });

    test('kind:2 patch with requests appends to existing requests', () => {
        const existingTurn = makeTurn('r1', 'Hello', 'Hi there');
        const newTurn = makeTurn('r2', 'Second', 'Second reply');
        const filePath = writeJsonl('append-patch.jsonl', [
            makeSnapshot({ sessionId: 'sess3', requests: [existingTurn] }),
            makePatch(['requests'], [newTurn], 2),
        ]);
        const { session } = parseCopilotSession(filePath, 'ws1');
        assert.strictEqual(session.messages.length, 4); // 2 turns × 2 messages each
    });

    test('turn without requestId uses fallback id', () => {
        const turn = { kind: null, timestamp: 1700000000000, message: { text: 'No requestId' }, response: [{ value: 'Response' }] };
        const filePath = writeJsonl('no-request-id.jsonl', [
            makeSnapshot({ sessionId: 'sess4', requests: [turn] }),
        ]);
        const { session } = parseCopilotSession(filePath, 'ws1');
        assert.strictEqual(session.messages.length, 2);
        // Message id should not contain "undefined"
        assert.ok(!session.messages[0].id.includes('undefined'));
    });

    test('title falls back to Untitled Session when no user messages', () => {
        const filePath = writeJsonl('no-user-messages.jsonl', [
            makeSnapshot({ sessionId: 'sess5', requests: [] }),
        ]);
        const { session } = parseCopilotSession(filePath, 'ws1');
        assert.strictEqual(session.title, 'Untitled Session');
    });

    test('createdAt falls back to file birthtime when no creationDate', () => {
        const filePath = writeJsonl('no-creation-date.jsonl', [
            makeSnapshot({ sessionId: 'sess6', requests: [makeTurn('r1', 'Hi', 'Hello', 1700000000000)] }),
        ]);
        const { session } = parseCopilotSession(filePath, 'ws1');
        assert.ok(session.createdAt, 'createdAt should be set');
        // Should not be epoch
        assert.ok(!session.createdAt.startsWith('1970'));
    });

    test('response item with kind field is excluded from AI text', () => {
        const turn = {
            requestId: 'r1', kind: null, timestamp: 1700000000000,
            message: { text: 'Question' },
            response: [
                { value: 'Real answer', kind: undefined }, // no kind = included
                { value: 'Metadata', kind: 'some_metadata' }, // kind present = excluded
            ],
        };
        const filePath = writeJsonl('response-filter.jsonl', [
            makeSnapshot({ sessionId: 'sess7', requests: [turn] }),
        ]);
        const { session } = parseCopilotSession(filePath, 'ws1');
        const assistantMsg = session.messages.find(m => m.role === 'assistant');
        assert.ok(assistantMsg);
        assert.ok(assistantMsg.content.includes('Real answer'));

        assert.ok(!assistantMsg.content.includes('Metadata'));
    });

    test('deepSet with array key and valid index updates state', () => {
        // A kind:1 patch with a numeric array key exercises deepSet's array branch
        const turn = makeTurn('r1', 'Test', 'Reply');
        const filePath = writeJsonl('deep-set-array.jsonl', [
            makeSnapshot({ sessionId: 'sess8', requests: [turn], nestedArr: ['old'] }),
            makePatch(['nestedArr', 0], 'new', 1),
        ]);
        const { session } = parseCopilotSession(filePath, 'ws1');
        assert.ok(session.messages.length >= 2);
    });

    test('invalid JSON line in middle of file is reported as error', () => {
        const goodLine = JSON.stringify(makeSnapshot({ sessionId: 'sess9', requests: [makeTurn('r1', 'Hi', 'Hello')] }));
        const filePath = path.join(tmpDir, 'invalid-json.jsonl');
        fs.writeFileSync(filePath, goodLine + '\nNOT_JSON\n', 'utf-8');
        const { errors } = parseCopilotSession(filePath, 'ws1');
        assert.ok(errors.some(e => e.includes('invalid JSON')));
    });

    test('deepSet with empty keys array is a no-op', () => {
        // A patch with empty k array — deepSet should return early without error
        const turn = makeTurn('r1', 'Hello', 'World');
        const filePath = writeJsonl('empty-key-patch.jsonl', [
            makeSnapshot({ sessionId: 'sess10', requests: [turn] }),
            makePatch([], 'value', 1),  // empty keys — should be ignored
        ]);
        const { session } = parseCopilotSession(filePath, 'ws1');
        assert.ok(session.messages.length >= 2, 'should still have messages after no-op patch');
    });

    test('deepSet rejects negative array index', () => {
        const turn = makeTurn('r1', 'Hi', 'Hello');
        const filePath = writeJsonl('neg-index.jsonl', [
            makeSnapshot({ sessionId: 'sess11', requests: [turn], arr: ['original'] }),
            makePatch(['arr', -1], 'bad', 1),
        ]);
        const { session } = parseCopilotSession(filePath, 'ws1');
        assert.ok(session.messages.length >= 1);
    });

    test('deepSet rejects oversized array index', () => {
        const turn = makeTurn('r1', 'Hi', 'Hello');
        const filePath = writeJsonl('big-index.jsonl', [
            makeSnapshot({ sessionId: 'sess12', requests: [turn], arr: ['original'] }),
            makePatch(['arr', 999999999], 'bad', 1),
        ]);
        const { session } = parseCopilotSession(filePath, 'ws1');
        assert.ok(session.messages.length >= 1);
    });

    test('kind:2 requests patch when state.requests is not an array uses empty base', () => {
        const turn = makeTurn('r1', 'Hello', 'World');
        // Snapshot has requests as a string (not array) — kind:2 patch should still work
        const filePath = writeJsonl('requests-not-array.jsonl', [
            makeSnapshot({ sessionId: 'sess13', requests: 'not-an-array' }),
            makePatch(['requests'], [turn], 2),
        ]);
        const { session } = parseCopilotSession(filePath, 'ws1');
        assert.ok(session.messages.length >= 2, 'should build messages from kind:2 appended requests');
    });

    test('turn without message text produces no user message', () => {
        const turn = { requestId: 'r1', kind: null, timestamp: 1700000000000, message: { text: '' }, response: [{ value: 'AI response' }] };
        const filePath = writeJsonl('no-user-text.jsonl', [
            makeSnapshot({ sessionId: 'sess14', requests: [turn] }),
        ]);
        const { session } = parseCopilotSession(filePath, 'ws1');
        assert.strictEqual(session.messages.filter(m => m.role === 'user').length, 0);
        assert.strictEqual(session.messages.filter(m => m.role === 'assistant').length, 1);
    });

    test('turn without timestamp has undefined timestamp on messages', () => {
        const turn = { requestId: 'r1', kind: null, message: { text: 'Hi' }, response: [{ value: 'Hello' }] };
        const filePath = writeJsonl('no-timestamp.jsonl', [
            makeSnapshot({ sessionId: 'sess15', requests: [turn] }),
        ]);
        const { session } = parseCopilotSession(filePath, 'ws1');
        assert.strictEqual(session.messages[0].timestamp, undefined);
    });

    test('customTitle is used as session title', () => {
        const turn = makeTurn('r1', 'First user message', 'AI response');
        const filePath = writeJsonl('custom-title.jsonl', [
            makeSnapshot({ sessionId: 'sess16', customTitle: 'My Custom Title', requests: [turn] }),
        ]);
        const { session } = parseCopilotSession(filePath, 'ws1');
        assert.strictEqual(session.title, 'My Custom Title');
    });

    test('title uses empty content fallback when first line is empty', () => {
        // First user message starts with newline so fl (first line) is empty
        const turn = { requestId: 'r1', kind: null, timestamp: 1700000000000, message: { text: '\nActual content here' }, response: [] };
        const filePath = writeJsonl('empty-first-line.jsonl', [
            makeSnapshot({ sessionId: 'sess17', requests: [turn] }),
        ]);
        const { session } = parseCopilotSession(filePath, 'ws1');
        assert.ok(session.title, 'title should not be empty');
    });

    test('line with unknown kind is skipped gracefully', () => {
        const goodLine = JSON.stringify(makeSnapshot({ sessionId: 'sess18', requests: [makeTurn('r1', 'Hi', 'Hello')] }));
        const unknownKindLine = JSON.stringify({ kind: 99, k: ['x'], v: 'val' });
        const filePath = path.join(tmpDir, 'unknown-kind.jsonl');
        fs.writeFileSync(filePath, goodLine + '\n' + unknownKindLine, 'utf-8');
        const { session } = parseCopilotSession(filePath, 'ws1');
        assert.ok(session.messages.length >= 1);
    });
});

// ---------------------------------------------------------------------------
// parseCopilotSession — terminal notification filtering
// ---------------------------------------------------------------------------
// Fixture: session-with-terminal-notifications.jsonl
// Three turns: real prompt → terminal notification → real prompt
// Expectation: notification turn produces no user message; final count = 4
// ---------------------------------------------------------------------------

suite('parseCopilotSession — terminal notification filtering', () => {

    const FIXTURE = path.join(FIXTURE_DIR, 'session-with-terminal-notifications.jsonl');

    test('returns no errors', () => {
        const { errors } = parseCopilotSession(FIXTURE, 'ws-notify');
        assert.strictEqual(errors.length, 0, `Unexpected errors: ${errors.join(', ')}`);
    });

    test('session has exactly 4 messages (notification turn produces none)', () => {
        const { session } = parseCopilotSession(FIXTURE, 'ws-notify');
        assert.strictEqual(session.messages.length, 4,
            `Expected 4 msgs (2 real turns × user+assistant), got ${session.messages.length}`);
    });

    test('messages alternate user/assistant/user/assistant', () => {
        const { session } = parseCopilotSession(FIXTURE, 'ws-notify');
        const roles = session.messages.map((m: Message) => m.role);
        assert.deepStrictEqual(roles, ['user', 'assistant', 'user', 'assistant']);
    });

    test('no message content contains the terminal notification text', () => {
        const { session } = parseCopilotSession(FIXTURE, 'ws-notify');
        for (const msg of session.messages) {
            assert.ok(
                !msg.content.includes('[Terminal'),
                `Message "${msg.content.slice(0, 60)}" should not contain notification text`
            );
        }
    });

    test('first user message is the ESLint question', () => {
        const { session } = parseCopilotSession(FIXTURE, 'ws-notify');
        assert.strictEqual(session.messages[0].content,
            'How do I configure ESLint in a TypeScript project?');
    });

    test('second user message is the Prettier question', () => {
        const { session } = parseCopilotSession(FIXTURE, 'ws-notify');
        assert.strictEqual(session.messages[2].content,
            'How do I integrate Prettier with ESLint?');
    });

    test('message IDs skip the notification request ID', () => {
        const { session } = parseCopilotSession(FIXTURE, 'ws-notify');
        assert.strictEqual(session.messages[0].id, 'req-001');
        assert.strictEqual(session.messages[1].id, 'req-001-response');
        assert.strictEqual(session.messages[2].id, 'req-003');
        assert.strictEqual(session.messages[3].id, 'req-003-response');
    });

    test('title is derived from the first real user message', () => {
        const { session } = parseCopilotSession(FIXTURE, 'ws-notify');
        assert.strictEqual(session.title, 'How do I configure ESLint in a TypeScript project?');
    });

});

// ---------------------------------------------------------------------------
// parseCopilotSession — textEditGroup handling
// ---------------------------------------------------------------------------
// Fixture: session-with-tool-calls.jsonl
// Turn 1: AI responds with textEditGroup for a .ts file (surrounded by ``` fences)
// ---------------------------------------------------------------------------

suite('parseCopilotSession — textEditGroup handling', () => {

    const FIXTURE = path.join(FIXTURE_DIR, 'session-with-tool-calls.jsonl');

    test('returns no errors', () => {
        const { errors } = parseCopilotSession(FIXTURE, 'ws-teg');
        assert.strictEqual(errors.length, 0, `Unexpected errors: ${errors.join(', ')}`);
    });

    test('first assistant response contains a TypeScript code fence', () => {
        const { session } = parseCopilotSession(FIXTURE, 'ws-teg');
        const asstMsg = session.messages[1];
        assert.ok(asstMsg.content.includes('```typescript'),
            `Expected TypeScript code fence, got: ${asstMsg.content.slice(0, 120)}`);
    });

    test('first assistant response contains the refactored function code', () => {
        const { session } = parseCopilotSession(FIXTURE, 'ws-teg');
        const asstMsg = session.messages[1];
        assert.ok(asstMsg.content.includes('export function formatDate'),
            'Should include the refactored function definition');
        assert.ok(asstMsg.content.includes('Date | null'),
            'Should include the null-safe parameter type');
    });

    test('empty ``` fence placeholder is removed (not left as standalone fence)', () => {
        const { session } = parseCopilotSession(FIXTURE, 'ws-teg');
        const asstMsg = session.messages[1];
        // If the textEditGroup replacement failed, the opening and closing ``` placeholders
        // would appear on consecutive lines with no content or language tag between them.
        // A properly replaced block has ``` <lang> as its opening line, not a bare ```.
        const orphanedFencePair = asstMsg.content.match(/^```[ \t]*\r?\n```/m);
        assert.strictEqual(orphanedFencePair, null,
            'Standalone ``` fence placeholder should have been replaced by the textEditGroup');
    });

    test('language is inferred from file extension (.ts → typescript)', () => {
        const { session } = parseCopilotSession(FIXTURE, 'ws-teg');
        const asstMsg = session.messages[1];
        // The code block in extractCodeBlocks should have language 'typescript'
        const tsBlock = asstMsg.codeBlocks.find((b: { language: string }) => b.language === 'typescript');
        assert.ok(tsBlock !== undefined, 'Should have a code block with language "typescript"');
    });

    test('non-code surrounding text is preserved', () => {
        const { session } = parseCopilotSession(FIXTURE, 'ws-teg');
        const asstMsg = session.messages[1];
        assert.ok(asstMsg.content.includes('Here is the updated implementation'),
            'Surrounding prose text should be retained');
        assert.ok(asstMsg.content.includes('non-null-safe version'),
            'Text after the code block should be retained');
    });

});

// ---------------------------------------------------------------------------
// parseCopilotSession — inlineReference handling
// ---------------------------------------------------------------------------
// Fixture: session-with-tool-calls.jsonl
// Turn 2: AI response contains both a Type B file reference and a Type A symbol reference
// ---------------------------------------------------------------------------

suite('parseCopilotSession — inlineReference handling', () => {

    const FIXTURE = path.join(FIXTURE_DIR, 'session-with-tool-calls.jsonl');

    test('Type B file reference (top-level name field) is rendered as backtick-wrapped name', () => {
        const { session } = parseCopilotSession(FIXTURE, 'ws-ref');
        const asstMsg = session.messages[3]; // second assistant response
        assert.ok(asstMsg.content.includes('`src/utils/formatDate.ts`'),
            `Expected file ref, content was: ${asstMsg.content}`);
    });

    test('Type A symbol reference (inlineReference.name) is rendered as backtick-wrapped name', () => {
        const { session } = parseCopilotSession(FIXTURE, 'ws-ref');
        const asstMsg = session.messages[3];
        assert.ok(asstMsg.content.includes('`formatDate`'),
            `Expected symbol ref, content was: ${asstMsg.content}`);
    });

    test('surrounding text is preserved alongside inline references', () => {
        const { session } = parseCopilotSession(FIXTURE, 'ws-ref');
        const asstMsg = session.messages[3];
        assert.ok(asstMsg.content.includes('Updated'), 'Preceding text should be present');
        assert.ok(asstMsg.content.includes('JSDoc'), 'Trailing text should be present');
    });

});

// ---------------------------------------------------------------------------
// parseCopilotSession — interrupted flag
// ---------------------------------------------------------------------------
// Fixture: session-with-tool-calls.jsonl
// Turn 3: AI responds with only toolInvocationSerialized (no text)
//   → user message gets interrupted=true, no assistant message is added
// ---------------------------------------------------------------------------

suite('parseCopilotSession — interrupted flag', () => {

    const FIXTURE = path.join(FIXTURE_DIR, 'session-with-tool-calls.jsonl');

    test('total message count is 5 (tool-call turn produces no assistant message)', () => {
        const { session } = parseCopilotSession(FIXTURE, 'ws-int');
        assert.strictEqual(session.messages.length, 5,
            `Expected 5 msgs: 3 users + 2 assistants (no asst for tool-call turn), got ${session.messages.length}`);
    });

    test('last message is the user message from the tool-call turn', () => {
        const { session } = parseCopilotSession(FIXTURE, 'ws-int');
        const last = session.messages[4];
        assert.strictEqual(last.role, 'user');
        assert.ok(last.content.includes('What unit tests should I write'),
            `Expected unit-test question, got: ${last.content}`);
    });

    test('user message from tool-call turn has interrupted=true', () => {
        const { session } = parseCopilotSession(FIXTURE, 'ws-int');
        const last = session.messages[4];
        assert.strictEqual((last as Message & { interrupted?: boolean }).interrupted, true,
            'interrupted flag should be set on the user message when AI used tools without text');
    });

    test('normal user messages do NOT have interrupted=true', () => {
        const { session } = parseCopilotSession(FIXTURE, 'ws-int');
        // First and second user messages had real AI responses
        const firstUser  = session.messages[0];
        const secondUser = session.messages[2];
        assert.ok(!(firstUser  as Message & { interrupted?: boolean }).interrupted, 'First user msg should not be interrupted');
        assert.ok(!(secondUser as Message & { interrupted?: boolean }).interrupted, 'Second user msg should not be interrupted');
    });

    test('inline construction: interrupted is set when AI response has only toolInvocationSerialized', () => {
        // This test constructs the session inline to verify the flag without relying on a fixture file.
        const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-interrupted-'));
        try {
            const filePath = path.join(tmpDir2, 'interrupted-inline.jsonl');
            const snapshot = { kind: 0, v: { sessionId: 'int-inline', creationDate: 1705400000000, requests: [], inputState: {} } };
            const patch = {
                kind: 2, k: ['requests'], v: [{
                    requestId: 'ri-1', kind: null, timestamp: 1705400005000,
                    message: { text: 'Quick question' },
                    response: [{ kind: 'toolInvocationSerialized', value: '{"tool":"search"}' }],
                }],
            };
            fs.writeFileSync(filePath, JSON.stringify(snapshot) + '\n' + JSON.stringify(patch), 'utf-8');
            const { session } = parseCopilotSession(filePath, 'ws-inline');
            assert.strictEqual(session.messages.length, 1, 'Only the user message should be present');
            assert.strictEqual((session.messages[0] as Message & { interrupted?: boolean }).interrupted, true);
        } finally {
            fs.rmSync(tmpDir2, { recursive: true, force: true });
        }
    });

});
