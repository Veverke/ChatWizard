// test/suite/integration/export.test.ts
//
// Integration tests — Markdown Export (scenarios 37–39)
//
// Exercises serializeSession() and serializeSessions() against fixture data and
// verifies the output structure matches the documented Markdown format.

import * as assert from 'assert';
import * as path from 'path';

import { serializeSession, serializeSessions } from '../../../src/export/markdownSerializer';
import { parseCopilotSession } from '../../../src/parsers/copilot';
import { parseClaudeSession } from '../../../src/parsers/claude';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const FIXTURES = path.resolve(__dirname, '../../../..', 'test', 'fixtures');
const COPILOT_FX = path.join(FIXTURES, 'copilot');
const CLAUDE_FX  = path.join(FIXTURES, 'claude');

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('Markdown Export', function () {
    this.timeout(10_000);

    // ── Test 37: Export single session ────────────────────────────────────

    test('37 — serializeSession starts with a H1 title', () => {
        const { session } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'), 'ws-37a'
        );

        const md = serializeSession(session);

        assert.ok(md.startsWith('# '), `output should start with "# ", got: ${md.slice(0, 40)}`);
        // sample-session.jsonl title is about centering in CSS
        assert.ok(md.includes('How do I center') || md.includes('center'),
            'title should be about CSS centering');
    });

    test('37b — serializeSession includes user prompt as H2 heading', () => {
        const { session } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'), 'ws-37b'
        );

        const md = serializeSession(session);

        assert.ok(md.includes('## '), 'output should contain an H2 for the user prompt');
    });

    test('37c — serializeSession includes "### Response" for assistant turn', () => {
        const { session } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'), 'ws-37c'
        );

        const md = serializeSession(session);

        assert.ok(md.includes('### Response'), 'output should contain "### Response"');
    });

    test('37d — serializeSession includes metadata (Source, Updated)', () => {
        const { session } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'), 'ws-37d'
        );

        const md = serializeSession(session);

        assert.ok(md.includes('**Source:**'), 'metadata should include Source');
        assert.ok(md.includes('**Updated:**'), 'metadata should include Updated date');
    });

    test('37e — serializeSession includes message content', () => {
        const { session } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'), 'ws-37e'
        );

        const md = serializeSession(session);

        // The CSS centering session mentions flexbox / grid
        assert.ok(
            md.toLowerCase().includes('flexbox') || md.toLowerCase().includes('grid') || md.toLowerCase().includes('css'),
            'output should contain CSS-related content from the session'
        );
    });

    // ── Test 38: Export multiple sessions ────────────────────────────────

    test('38 — serializeSessions includes preamble comment', () => {
        const { session: s1 } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'), 'ws-38a-s1'
        );
        const { session: s2 } = parseCopilotSession(
            path.join(COPILOT_FX, 'session-with-model.jsonl'), 'ws-38a-s2'
        );

        const md = serializeSessions([s1, s2], 'combined');

        assert.ok(md.includes('<!-- Chat Wizard export'), 'output should start with the export preamble comment');
    });

    test('38b — serializeSessions includes a Table of Contents', () => {
        const { session: s1 } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'), 'ws-38b-s1'
        );
        const { session: s2 } = parseCopilotSession(
            path.join(COPILOT_FX, 'session-with-model.jsonl'), 'ws-38b-s2'
        );

        const md = serializeSessions([s1, s2], 'combined');

        assert.ok(md.includes('## Table of Contents'), 'output should contain a Table of Contents heading');
    });

    test('38c — serializeSessions includes both session titles in TOC', () => {
        const { session: s1 } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'), 'ws-38c-s1'
        );
        const { session: s2 } = parseCopilotSession(
            path.join(COPILOT_FX, 'session-with-model.jsonl'), 'ws-38c-s2'
        );

        const md = serializeSessions([s1, s2], 'combined');

        // Both session titles should appear in the document
        const s1TitleFragment = s1.title.slice(0, 20);
        const s2TitleFragment = s2.title.slice(0, 20);
        assert.ok(md.includes(s1TitleFragment),
            `output should contain fragment of session 1 title: "${s1TitleFragment}"`);
        assert.ok(md.includes(s2TitleFragment),
            `output should contain fragment of session 2 title: "${s2TitleFragment}"`);
    });

    test('38d — serializeSessions with cross-source sessions (copilot + claude)', () => {
        const { session: copilotSession } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'), 'ws-38d-cpt'
        );
        const { session: claudeSession } = parseClaudeSession(
            path.join(CLAUDE_FX, 'sample-session.jsonl')
        );

        const md = serializeSessions([copilotSession, claudeSession], 'combined');

        // Output should reference both source types
        assert.ok(md.includes('GitHub Copilot') || md.includes('Copilot'),
            'output should reference Copilot as source');
        assert.ok(md.includes('Claude'),
            'output should reference Claude as source');
    });

    // ── Test 39: Model field in export ────────────────────────────────────

    test('39 — serializeSession includes model name when session has a model', () => {
        const { session } = parseCopilotSession(
            path.join(COPILOT_FX, 'session-with-model.jsonl'), 'ws-39a'
        );

        // Verify the session was parsed with a model field
        assert.strictEqual(session.model, 'gpt-4o',
            `session fixture should have model "gpt-4o", got "${session.model}"`);

        const md = serializeSession(session);

        assert.ok(md.includes('**Model:**'), 'output should include **Model:** metadata label');
        assert.ok(md.includes('gpt-4o'), 'output should include the model name "gpt-4o"');
    });

    test('39b — serializeSession includes claude model name', () => {
        const { session } = parseCopilotSession(
            path.join(COPILOT_FX, 'session-with-claude-model.jsonl'), 'ws-39b'
        );

        assert.ok(session.model?.startsWith('claude-'),
            `expected a claude model string, got "${session.model}"`);

        const md = serializeSession(session);

        assert.ok(md.includes('**Model:**'), 'output should include **Model:** metadata label');
        assert.ok(md.includes('claude'), 'output should include "claude" in the model name');
    });

    test('39c — serializeSession omits Model line when session has no model', () => {
        const { session } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'), 'ws-39c'
        );

        // sample-session.jsonl has no model field
        assert.ok(!session.model, 'sample-session.jsonl should have no model field');

        const md = serializeSession(session);

        assert.ok(!md.includes('**Model:**'), 'output should not include **Model:** when model is absent');
    });

    // ── Security: XSS-unsafe link sanitisation ────────────────────────────

    test('SEC-9 — unsafe javascript: links are stripped from export', () => {
        const { session } = parseCopilotSession(
            path.join(COPILOT_FX, 'sample-session.jsonl'), 'ws-sec-1'
        );

        // Inject a malicious link into the session content
        const injectedSession = {
            ...session,
            messages: [
                ...session.messages,
                {
                    id: 'injected-msg',
                    role: 'assistant' as const,
                    content: 'Click here: [malicious](javascript:alert(1))',
                    codeBlocks: [],
                },
            ],
        };

        const md = serializeSession(injectedSession);

        assert.ok(!md.includes('javascript:'), 'javascript: URL should be stripped from export');
        assert.ok(md.includes('[malicious]'), 'link text should be preserved even when URL is stripped');
    });
});
