// test/e2e/amazonQParser.test.ts
//
// Tests the Amazon Q Developer parser against two real-world fixture files
// that mirror the two JSON shapes Amazon Q writes to its VS Code storage:
//
//   Shape A — history-style: messages[].type = 'prompt' | 'answer'
//             conversationId at top level, used by Amazon Q ≤ 1.x
//
//   Shape B — newer SDK shape: messages[].sender = 'USER' | 'ASSISTANT'
//             id at top level, used by Amazon Q ≥ 2.x (Nova models)
//
// Fixtures contain realistic AWS-focused conversations (Lambda cold starts,
// DynamoDB GSI optimization) with multi-turn dialogue and code blocks.

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { parseAmazonQSession } from '../../src/parsers/amazonQ';

const FIXTURES_DIR = path.resolve(__dirname, '../../..', 'test', 'fixtures', 'amazonq');

suite('Amazon Q Parser — Shape A (type: prompt/answer)', () => {

    // fixture: lambda-cold-start-shape-a.json
    // A 4-message conversation about reducing Lambda cold start times.
    // Uses Shape A: messages[i].type = 'prompt' | 'answer', conversationId at root.

    let result: ReturnType<typeof parseAmazonQSession>;

    setup(() => {
        result = parseAmazonQSession(path.join(FIXTURES_DIR, 'lambda-cold-start-shape-a.json'));
    });

    test('parses without errors', () => {
        assert.strictEqual(result.errors.length, 0);
    });

    test('source is amazonq', () => {
        assert.strictEqual(result.session.source, 'amazonq');
    });

    test('session ID comes from conversationId field', () => {
        assert.strictEqual(result.session.id, 'amzq-lambda-cold-start-001');
    });

    test('title comes from the title field', () => {
        assert.strictEqual(result.session.title, 'Debugging Lambda cold start latency');
    });

    test('all 4 messages are parsed', () => {
        assert.strictEqual(result.session.messages.length, 4);
    });

    test('type:prompt messages are mapped to role:user', () => {
        const userMessages = result.session.messages.filter(m => m.role === 'user');
        assert.strictEqual(userMessages.length, 2);
    });

    test('type:answer messages are mapped to role:assistant', () => {
        const assistantMessages = result.session.messages.filter(m => m.role === 'assistant');
        assert.strictEqual(assistantMessages.length, 2);
    });

    test('first user message describes the Lambda cold start problem', () => {
        const content = result.session.messages[0].content;
        assert.ok(content.includes('Lambda'), `Missing "Lambda": ${content.slice(0, 80)}`);
        assert.ok(content.includes('cold start'), `Missing "cold start": ${content.slice(0, 80)}`);
    });

    test('assistant response contains a javascript or bash code block', () => {
        const assistant = result.session.messages[1];
        assert.ok(assistant.codeBlocks.length > 0, 'Expected code blocks in answer');
        const hasJsOrBash = assistant.codeBlocks.some(
            b => b.language === 'javascript' || b.language === 'bash' || b.language === 'js',
        );
        assert.ok(hasJsOrBash, `Expected js/bash block, got: ${assistant.codeBlocks.map(b => b.language).join(', ')}`);
    });

    test('createdAt is parsed from the top-level createdAt timestamp', () => {
        const d = new Date(result.session.createdAt);
        assert.ok(d.getFullYear() >= 2024, `Expected recent date: ${result.session.createdAt}`);
    });

});

suite('Amazon Q Parser — Shape B (sender: USER/ASSISTANT)', () => {

    // fixture: dynamodb-gsi-shape-b.json
    // A 4-message conversation about DynamoDB GSI hot-partition optimization.
    // Uses Shape B: messages[i].sender = 'USER' | 'ASSISTANT', id at root.
    // Model field (amazon.nova-pro-v1:0) is at root level.

    let result: ReturnType<typeof parseAmazonQSession>;

    setup(() => {
        result = parseAmazonQSession(path.join(FIXTURES_DIR, 'dynamodb-gsi-shape-b.json'));
    });

    test('parses without errors', () => {
        assert.strictEqual(result.errors.length, 0);
    });

    test('source is amazonq', () => {
        assert.strictEqual(result.session.source, 'amazonq');
    });

    test('session ID comes from id field', () => {
        assert.strictEqual(result.session.id, 'amzq-session-dynamodb-002');
    });

    test('title comes from the title field', () => {
        assert.strictEqual(result.session.title, 'Optimizing DynamoDB GSI query performance');
    });

    test('model is populated from the root model field', () => {
        assert.ok(result.session.model?.includes('nova'), `Expected nova model, got: ${result.session.model}`);
    });

    test('sender:USER messages are mapped to role:user', () => {
        const userMsgs = result.session.messages.filter(m => m.role === 'user');
        assert.strictEqual(userMsgs.length, 2);
    });

    test('sender:ASSISTANT messages are mapped to role:assistant', () => {
        const assistantMsgs = result.session.messages.filter(m => m.role === 'assistant');
        assert.strictEqual(assistantMsgs.length, 2);
    });

    test('first user message describes the DynamoDB GSI latency problem', () => {
        const content = result.session.messages[0].content;
        assert.ok(content.includes('DynamoDB'), `Missing "DynamoDB": ${content.slice(0, 80)}`);
        assert.ok(content.includes('GSI'), `Missing "GSI": ${content.slice(0, 80)}`);
    });

    test('assistant response contains a Python or TypeScript code block', () => {
        // First assistant response has Python CloudWatch code
        const assistant = result.session.messages[1];
        assert.ok(assistant.codeBlocks.length > 0, 'Expected code blocks');
        const hasPyOrTs = assistant.codeBlocks.some(
            b => b.language === 'python' || b.language === 'typescript' || b.language === 'ts',
        );
        assert.ok(hasPyOrTs, `Expected python/typescript block, got: ${assistant.codeBlocks.map(b => b.language).join(', ')}`);
    });

    test('second assistant response contains a TypeScript repository class', () => {
        // The fourth message (index 3) is the shard fan-out TypeScript code
        const secondAssistant = result.session.messages[3];
        assert.ok(secondAssistant.role === 'assistant');
        const tsBlock = secondAssistant.codeBlocks.find(b => b.language === 'typescript' || b.language === 'ts');
        assert.ok(tsBlock, 'Expected TypeScript code block in second assistant message');
        assert.ok(tsBlock!.content.includes('OrderRepository'), 'Code should contain OrderRepository class');
    });

});

suite('Amazon Q Parser — error paths', () => {

    test('non-existent file reports error and returns empty session', () => {
        const r = parseAmazonQSession(path.join(FIXTURES_DIR, 'does-not-exist.json'));
        assert.ok(r.errors.length > 0);
        assert.strictEqual(r.session.messages.length, 0);
    });

    test('invalid JSON reports error, source still amazonq', () => {
        const tmp = path.join(os.tmpdir(), 'cw-test-bad-amazonq.json');
        fs.writeFileSync(tmp, '{ not valid json }', 'utf-8');
        try {
            const r = parseAmazonQSession(tmp);
            assert.ok(r.errors.length > 0);
            assert.strictEqual(r.session.source, 'amazonq');
            assert.strictEqual(r.session.messages.length, 0);
        } finally {
            fs.unlinkSync(tmp);
        }
    });

    test('valid JSON with no messages array returns zero messages, no crash', () => {
        const tmp = path.join(os.tmpdir(), 'cw-test-empty-amazonq.json');
        fs.writeFileSync(tmp, JSON.stringify({ id: 'empty-session', title: 'Empty', messages: [] }), 'utf-8');
        try {
            const r = parseAmazonQSession(tmp);
            assert.strictEqual(r.session.messages.length, 0);
            assert.strictEqual(r.errors.length, 0);
        } finally {
            fs.unlinkSync(tmp);
        }
    });

    test('messages with unknown type/sender are silently skipped', () => {
        const tmp = path.join(os.tmpdir(), 'cw-test-unknown-types-amazonq.json');
        const data = {
            id: 'test-skip',
            title: 'Mixed message types',
            messages: [
                { sender: 'USER', content: 'real user message' },
                { type: 'context', body: 'should be skipped — unknown type' },
                { sender: 'ASSISTANT', content: 'real assistant message' },
            ],
        };
        fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8');
        try {
            const r = parseAmazonQSession(tmp);
            assert.strictEqual(r.session.messages.length, 2, 'Should only parse USER and ASSISTANT messages');
            assert.strictEqual(r.session.messages[0].role, 'user');
            assert.strictEqual(r.session.messages[1].role, 'assistant');
        } finally {
            fs.unlinkSync(tmp);
        }
    });

});
