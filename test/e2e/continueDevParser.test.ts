// test/e2e/continueDevParser.test.ts
//
// Tests the Continue.dev parser against real-world fixture files that mirror
// the two session formats Continue.dev actually writes to disk:
//   - JSON object  (history: [...]) — produced by Continue.dev ≥ v0.8
//   - JSONL        (one message per line) — produced by older builds and exports
//
// Fixture content is realistic: actual code blocks, multi-turn debugging
// conversations, and the exact field names/shapes observed in the wild.

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { parseContinueSession } from '../../src/parsers/continueDev';

const FIXTURES_DIR = path.resolve(__dirname, '../../..', 'test', 'fixtures', 'continue');

suite('Continue.dev Parser — JSON object format', () => {

    // fixture: jwt-auth-json.json
    // A 4-message session about adding JWT auth middleware to an Express app.
    // The JSON object has sessionId, title, model, history[].

    let result: ReturnType<typeof parseContinueSession>;

    setup(() => {
        result = parseContinueSession(path.join(FIXTURES_DIR, 'jwt-auth-json.json'));
    });

    test('parses without errors', () => {
        assert.strictEqual(result.errors.length, 0);
    });

    test('source is continue', () => {
        assert.strictEqual(result.session.source, 'continue');
    });

    test('session ID comes from sessionId field, not filename stem', () => {
        assert.strictEqual(result.session.id, 'continue-jwt-001');
    });

    test('title is taken from the title field', () => {
        assert.strictEqual(result.session.title, 'Implementing JWT authentication in Express');
    });

    test('model is extracted from assistant messages', () => {
        assert.ok(
            result.session.model?.includes('claude') || result.session.model?.includes('sonnet'),
            `Expected claude/sonnet model, got: ${result.session.model}`,
        );
    });

    test('all 4 messages are parsed (2 user + 2 assistant)', () => {
        assert.strictEqual(result.session.messages.length, 4);
    });

    test('messages alternate user/assistant', () => {
        const roles = result.session.messages.map(m => m.role);
        assert.deepStrictEqual(roles, ['user', 'assistant', 'user', 'assistant']);
    });

    test('first user message mentions JWT and Express', () => {
        const first = result.session.messages[0].content;
        assert.ok(first.includes('JWT'), `Missing "JWT" in: ${first}`);
        assert.ok(first.includes('Express'), `Missing "Express" in: ${first}`);
    });

    test('assistant response contains a javascript code block', () => {
        const assistantMsg = result.session.messages[1];
        assert.ok(assistantMsg.codeBlocks.length > 0, 'Expected at least one code block');
        const jsBlock = assistantMsg.codeBlocks.find(
            b => b.language === 'javascript' || b.language === 'js',
        );
        assert.ok(jsBlock, 'Expected a javascript code block');
        assert.ok(jsBlock.content.includes('verifyToken'), 'Code block should contain verifyToken function');
    });

    test('createdAt is a valid ISO-8601 date, not epoch zero', () => {
        const d = new Date(result.session.createdAt);
        assert.ok(d.getFullYear() >= 2024, `Expected recent date, got: ${result.session.createdAt}`);
    });

});

suite('Continue.dev Parser — JSONL format', () => {

    // fixture: postgres-pool-jsonl.jsonl
    // A 4-message session about Postgres connection pool exhaustion.
    // Each line is a standalone JSON message object (role + content + timestamp).

    let result: ReturnType<typeof parseContinueSession>;

    setup(() => {
        result = parseContinueSession(path.join(FIXTURES_DIR, 'postgres-pool-jsonl.jsonl'));
    });

    test('parses without errors', () => {
        assert.strictEqual(result.errors.length, 0);
    });

    test('source is continue', () => {
        assert.strictEqual(result.session.source, 'continue');
    });

    test('parses all 4 messages from JSONL', () => {
        assert.strictEqual(result.session.messages.length, 4);
    });

    test('roles are correctly ordered (user/assistant/user/assistant)', () => {
        const roles = result.session.messages.map(m => m.role);
        assert.deepStrictEqual(roles, ['user', 'assistant', 'user', 'assistant']);
    });

    test('first user message describes the pool exhaustion error', () => {
        const content = result.session.messages[0].content;
        assert.ok(
            content.includes('remaining connection slots') || content.includes('pool'),
            `Message should describe pool issue: ${content.slice(0, 80)}`,
        );
    });

    test('assistant response contains a SQL or JavaScript code block', () => {
        const assistantMsg = result.session.messages[1];
        const hasCodeBlock = assistantMsg.codeBlocks.length > 0;
        assert.ok(hasCodeBlock, 'Expected code block in assistant response');
    });

    test('model is extracted from JSONL assistant messages', () => {
        assert.ok(result.session.model, 'Expected model to be populated from JSONL messages');
        assert.ok(result.session.model!.length > 0);
    });

    test('session ID falls back to filename stem when no sessionId in JSONL', () => {
        // JSONL format has no top-level sessionId field — should use filename stem
        assert.strictEqual(result.session.id, 'postgres-pool-jsonl');
    });

});

suite('Continue.dev Parser — error paths', () => {

    test('non-existent file reports error and returns empty session', () => {
        const r = parseContinueSession(path.join(FIXTURES_DIR, 'does-not-exist.json'));
        assert.ok(r.errors.length > 0);
        assert.strictEqual(r.session.messages.length, 0);
        assert.strictEqual(r.session.source, 'continue');
    });

    test('empty file reports error and returns empty session', () => {
        const tmp = path.join(os.tmpdir(), 'cw-test-empty-continue.json');
        fs.writeFileSync(tmp, '', 'utf-8');
        try {
            const r = parseContinueSession(tmp);
            assert.ok(r.errors.length > 0, 'Should report an error for empty file');
            assert.strictEqual(r.session.messages.length, 0);
        } finally {
            fs.unlinkSync(tmp);
        }
    });

    test('malformed JSON object falls through to JSONL parser, valid lines survive', () => {
        const tmp = path.join(os.tmpdir(), 'cw-test-partial-continue.jsonl');
        // First line is valid JSONL; second line is garbage
        fs.writeFileSync(tmp, '{"role":"user","content":"valid message"}\n{broken json\n', 'utf-8');
        try {
            const r = parseContinueSession(tmp);
            // The valid line should have been parsed
            assert.ok(r.session.messages.length >= 1, 'Should parse at least the valid line');
            // The broken line should have produced an error entry
            assert.ok(r.errors.length >= 1, 'Should report error for malformed line');
        } finally {
            fs.unlinkSync(tmp);
        }
    });

});
