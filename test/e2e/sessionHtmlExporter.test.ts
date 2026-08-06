// test/e2e/sessionHtmlExporter.test.ts
// Feature 36 — Session Sharing (HTML Bundle Exporter)

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exportSessionAsHtml } from '../../src/export/sessionHtmlExporter';
import type { Session, MessageAnnotation } from '../../src/types/index';

function makeSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'test-session-001',
        title: 'My Test Session',
        source: 'claude',
        workspaceId: 'ws1',
        messages: [
            {
                id: 'msg-0',
                role: 'user',
                content: 'How do I implement JWT auth?',
                codeBlocks: [],
            },
            {
                id: 'msg-1',
                role: 'assistant',
                content: 'Here is an example:\n\n```typescript\nconst token = jwt.sign(payload, secret);\n```\n\nThis is the basic usage.',
                codeBlocks: [],
            },
        ],
        filePath: '/tmp/test-session.jsonl',
        createdAt: '2026-06-01T10:00:00.000Z',
        updatedAt: '2026-06-01T10:30:00.000Z',
        ...overrides,
    };
}

suite('Feature 36 — Session HTML Exporter', () => {
    let tmpDir: string;

    suiteSetup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-html-test-'));
    });

    suiteTeardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('exports a valid HTML file', async () => {
        const outPath = path.join(tmpDir, 'test1.html');
        await exportSessionAsHtml(makeSession(), outPath);
        assert.ok(fs.existsSync(outPath), 'output file should exist');
    });

    test('output contains the session title in an h1 tag', async () => {
        const outPath = path.join(tmpDir, 'test-title.html');
        const session = makeSession({ title: 'JWT Auth Implementation' });
        await exportSessionAsHtml(session, outPath);
        const html = fs.readFileSync(outPath, 'utf8');
        assert.ok(html.includes('<h1>JWT Auth Implementation</h1>'), 'h1 should contain the session title');
    });

    test('output HTML contains no <script> tags', async () => {
        const outPath = path.join(tmpDir, 'test-noscript.html');
        await exportSessionAsHtml(makeSession(), outPath);
        const html = fs.readFileSync(outPath, 'utf8');
        assert.ok(!/<script/i.test(html), 'output should contain no script tags');
    });

    test('output includes all 5 messages for a session with 5 messages', async () => {
        const messages = Array.from({ length: 5 }, (_, i) => ({
            id: `msg-${i}`,
            role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
            content: `Message content ${i}`,
            codeBlocks: [],
        }));
        const session = makeSession({ messages });
        const outPath = path.join(tmpDir, 'test-5msg.html');
        await exportSessionAsHtml(session, outPath);
        const html = fs.readFileSync(outPath, 'utf8');
        for (let i = 0; i < 5; i++) {
            assert.ok(html.includes(`Message content ${i}`), `message ${i} should appear in output`);
        }
    });

    test('redactCodeBlocks: true removes code content from output', async () => {
        const outPath = path.join(tmpDir, 'test-redact.html');
        await exportSessionAsHtml(makeSession(), outPath, { redactCodeBlocks: true });
        const html = fs.readFileSync(outPath, 'utf8');
        assert.ok(!html.includes('jwt.sign(payload, secret)'), 'code content should be redacted');
        assert.ok(html.includes('[code block redacted]'), 'redaction placeholder should be present');
    });

    test('redactCodeBlocks: false (default) preserves code content', async () => {
        const outPath = path.join(tmpDir, 'test-noredact.html');
        await exportSessionAsHtml(makeSession(), outPath, { redactCodeBlocks: false });
        const html = fs.readFileSync(outPath, 'utf8');
        // The code will be HTML-escaped but the content should still be there
        assert.ok(html.includes('jwt.sign'), 'code content should be preserved when not redacting');
    });

    test('includeAnnotations: true renders annotation text in output', async () => {
        const annotations: MessageAnnotation[] = [
            { messageIndex: 1, text: 'This approach worked for me in prod', createdAt: '2026-06-01T10:05:00Z' },
        ];
        const outPath = path.join(tmpDir, 'test-annotations.html');
        await exportSessionAsHtml(makeSession(), outPath, { includeAnnotations: true, annotations });
        const html = fs.readFileSync(outPath, 'utf8');
        assert.ok(html.includes('This approach worked for me in prod'), 'annotation text should appear');
    });

    test('includeAnnotations: false does not render annotation text', async () => {
        const annotations: MessageAnnotation[] = [
            { messageIndex: 1, text: 'SECRET ANNOTATION', createdAt: '2026-06-01T10:05:00Z' },
        ];
        const outPath = path.join(tmpDir, 'test-no-annotations.html');
        await exportSessionAsHtml(makeSession(), outPath, { includeAnnotations: false, annotations });
        const html = fs.readFileSync(outPath, 'utf8');
        assert.ok(!html.includes('SECRET ANNOTATION'), 'annotation should not appear when includeAnnotations is false');
    });

    test('output HTML is valid DOCTYPE with UTF-8 charset', async () => {
        const outPath = path.join(tmpDir, 'test-doctype.html');
        await exportSessionAsHtml(makeSession(), outPath);
        const html = fs.readFileSync(outPath, 'utf8');
        assert.ok(html.startsWith('<!DOCTYPE html>'), 'should start with DOCTYPE');
        assert.ok(html.includes('charset="UTF-8"'), 'should declare UTF-8 charset');
    });

    test('creates output directory if it does not exist', async () => {
        const nestedPath = path.join(tmpDir, 'nested', 'deep', 'output.html');
        await exportSessionAsHtml(makeSession(), nestedPath);
        assert.ok(fs.existsSync(nestedPath), 'should create nested directories and file');
    });

    test('HTML-escapes session title to prevent XSS', async () => {
        const session = makeSession({ title: '<script>alert("xss")</script>' });
        const outPath = path.join(tmpDir, 'test-xss.html');
        await exportSessionAsHtml(session, outPath);
        const html = fs.readFileSync(outPath, 'utf8');
        assert.ok(!html.includes('<script>alert'), 'raw script tag should not appear in output');
        assert.ok(html.includes('&lt;script&gt;'), 'title should be HTML-escaped');
    });

    test('Generated by ChatWizard banner is present', async () => {
        const outPath = path.join(tmpDir, 'test-banner.html');
        await exportSessionAsHtml(makeSession(), outPath);
        const html = fs.readFileSync(outPath, 'utf8');
        assert.ok(html.includes('Generated by ChatWizard'), 'banner should be present');
    });
});