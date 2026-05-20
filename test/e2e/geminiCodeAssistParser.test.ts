// test/e2e/geminiCodeAssistParser.test.ts
//
// Tests the Gemini Code Assist parser against a real-world fixture that mirrors
// the JSON shape google.google-cloud-code writes to VS Code extension storage.
//
// Key parser behaviour tested here:
//   - role: 'model' is normalised to role: 'assistant'
//   - messages[].parts[].text is concatenated as message content
//   - model field is extracted from root
//   - ISO timestamps are preserved
//   - Code blocks embedded in parts text are extracted

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { parseGeminiCodeAssistSession } from '../../src/parsers/geminiCodeAssist';

const FIXTURES_DIR = path.resolve(__dirname, '../../..', 'test', 'fixtures', 'geminiCodeAssist');

suite('Gemini Code Assist Parser — monorepo build fixture', () => {

    // fixture: monorepo-build.json
    // A 4-message conversation about speeding up a TypeScript monorepo CI build
    // using Nx project references and tsbuildinfo caching.

    let result: ReturnType<typeof parseGeminiCodeAssistSession>;

    setup(() => {
        result = parseGeminiCodeAssistSession(path.join(FIXTURES_DIR, 'monorepo-build.json'));
    });

    test('parses without errors', () => {
        assert.strictEqual(result.errors.length, 0);
    });

    test('source is geminiCodeAssist', () => {
        assert.strictEqual(result.session.source, 'geminiCodeAssist');
    });

    test('session ID comes from id field', () => {
        assert.strictEqual(result.session.id, 'gemini-monorepo-build-001');
    });

    test('title comes from the title field', () => {
        assert.strictEqual(result.session.title, 'Speeding up TypeScript monorepo build times');
    });

    test('model is extracted from root model field', () => {
        assert.ok(
            result.session.model?.includes('gemini'),
            `Expected gemini model, got: ${result.session.model}`,
        );
    });

    test('all 4 messages are parsed', () => {
        assert.strictEqual(result.session.messages.length, 4);
    });

    test('role:model is normalised to role:assistant', () => {
        const assistantMessages = result.session.messages.filter(m => m.role === 'assistant');
        assert.strictEqual(assistantMessages.length, 2, 'Both model-role messages should map to assistant');
    });

    test('role:user messages are preserved', () => {
        const userMessages = result.session.messages.filter(m => m.role === 'user');
        assert.strictEqual(userMessages.length, 2);
    });

    test('first user message mentions the monorepo build time problem', () => {
        const content = result.session.messages[0].content;
        assert.ok(content.includes('monorepo') || content.includes('Nx'), `Missing monorepo context: ${content.slice(0, 80)}`);
        assert.ok(content.includes('build') || content.includes('minutes'), `Missing build problem: ${content.slice(0, 80)}`);
    });

    test('assistant response contains yaml and json code blocks', () => {
        const assistant = result.session.messages[1];
        assert.ok(assistant.codeBlocks.length > 0, 'Expected code blocks in first assistant reply');
        const languages = assistant.codeBlocks.map(b => b.language);
        const hasStructuredConfig = languages.some(l => ['yaml', 'json', 'bash'].includes(l ?? ''));
        assert.ok(hasStructuredConfig, `Expected yaml/json/bash block, got: ${languages.join(', ')}`);
    });

    test('second user message identifies the specific problematic package', () => {
        const content = result.session.messages[2].content;
        assert.ok(
            content.includes('@internal/ui') || content.includes('project references'),
            `Expected specific package mention: ${content.slice(0, 80)}`,
        );
    });

    test('second assistant message contains bash and json code blocks', () => {
        const assistant = result.session.messages[3];
        const langs = assistant.codeBlocks.map(b => b.language);
        assert.ok(langs.some(l => l === 'bash'), `Expected bash block, got: ${langs.join(', ')}`);
        assert.ok(langs.some(l => l === 'json'), `Expected json block, got: ${langs.join(', ')}`);
    });

    test('createdAt is a valid ISO date from the conversation', () => {
        const d = new Date(result.session.createdAt);
        assert.ok(d.getFullYear() >= 2025, `Expected 2025 date, got: ${result.session.createdAt}`);
    });

});

suite('Gemini Code Assist Parser — error paths', () => {

    test('non-existent file reports error and returns empty session', () => {
        const r = parseGeminiCodeAssistSession(path.join(FIXTURES_DIR, 'does-not-exist.json'));
        assert.ok(r.errors.length > 0);
        assert.strictEqual(r.session.messages.length, 0);
        assert.strictEqual(r.session.source, 'geminiCodeAssist');
    });

    test('valid JSON with flat content strings (alternate shape) is parsed', () => {
        const tmp = path.join(os.tmpdir(), 'cw-test-flat-gemini.json');
        // Some Gemini versions write content as a plain string, not parts array
        const data = {
            id: 'gemini-flat-001',
            model: 'gemini-1.5-pro',
            messages: [
                { role: 'user', content: 'How does React reconciliation work?' },
                { role: 'model', content: 'React reconciliation is the algorithm React uses to diff the virtual DOM...' },
            ],
        };
        fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8');
        try {
            const r = parseGeminiCodeAssistSession(tmp);
            assert.strictEqual(r.session.messages.length, 2);
            assert.strictEqual(r.session.messages[0].role, 'user');
            assert.strictEqual(r.session.messages[1].role, 'assistant');
            assert.ok(r.session.messages[1].content.includes('reconciliation'));
        } finally {
            fs.unlinkSync(tmp);
        }
    });

    test('messages with empty parts produce no content and are skipped', () => {
        const tmp = path.join(os.tmpdir(), 'cw-test-empty-parts-gemini.json');
        const data = {
            id: 'gemini-empty-001',
            messages: [
                { role: 'user', parts: [{ text: 'real message' }] },
                { role: 'model', parts: [] },    // empty parts — should be skipped
                { role: 'user', parts: [{ text: 'follow-up' }] },
            ],
        };
        fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8');
        try {
            const r = parseGeminiCodeAssistSession(tmp);
            // Only messages with non-empty content should be parsed
            assert.ok(r.session.messages.length <= 2, 'Empty-parts message should be dropped');
        } finally {
            fs.unlinkSync(tmp);
        }
    });

});
