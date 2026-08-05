// test/e2e/kbLlmClassifier.test.ts
// Feature 23 — LLM Classifier: prompt building, response parsing, fallback logic

import * as assert from 'assert';
import {
    buildClassificationPrompt,
    buildSystemPrompt,
    parseClassification,
} from '../../src/analytics/kbLlmClassifier';
import type { Session } from '../../src/types/index';

function makeSession(overrides?: Partial<Session>): Session {
    return {
        id: 'llm-test-sid',
        title: 'Test Session',
        source: 'copilot',
        workspaceId: 'ws1',
        messages: [{ id: 'm0', role: 'user', content: 'hello world', codeBlocks: [] }],
        filePath: '/tmp/test.jsonl',
        createdAt: '2026-06-01T10:00:00Z',
        updatedAt: '2026-06-01T10:30:00Z',
        ...overrides,
    };
}

suite('Feature 23 — LLM Classifier', () => {
    suite('buildClassificationPrompt', () => {
        test('includes session title', () => {
            const session = makeSession({ title: 'My Custom Title' });
            const prompt = buildClassificationPrompt(session);
            assert.ok(prompt.includes('Session title: My Custom Title'));
        });

        test('includes all messages (no cap)', () => {
            const messages = Array.from({ length: 20 }, (_, i) => ({
                id: `m${i}`,
                role: 'user' as const,
                content: `message ${i}`,
                codeBlocks: [] as never[],
            }));
            const session = makeSession({ messages });
            const prompt = buildClassificationPrompt(session);

            // All 20 messages should be present
            assert.ok(prompt.includes('[USER]\nmessage 0'));
            assert.ok(prompt.includes('[USER]\nmessage 19'));
        });

        test('formats messages with [ROLE] header', () => {
            const session = makeSession({
                messages: [
                    { id: 'm0', role: 'user', content: 'user text', codeBlocks: [] },
                    { id: 'm1', role: 'assistant', content: 'assistant text', codeBlocks: [] },
                ],
            });
            const prompt = buildClassificationPrompt(session);
            assert.ok(prompt.includes('[USER]\nuser text'));
            assert.ok(prompt.includes('[ASSISTANT]\nassistant text'));
        });

        test('does not truncate message content', () => {
            const longContent = 'x'.repeat(10000);
            const session = makeSession({
                messages: [{ id: 'm0', role: 'user', content: longContent, codeBlocks: [] }],
            });
            const prompt = buildClassificationPrompt(session);
            // Full content preserved
            assert.ok(prompt.includes(longContent));
        });
    });

    suite('buildSystemPrompt', () => {
        test('instructs to derive topic with up to 3 keywords', () => {
            const prompt = buildSystemPrompt();
            assert.ok(prompt.includes('up to 3 keywords'));
            assert.ok(prompt.includes('Return ONLY the category label'));
            assert.ok(prompt.includes('Other'));
        });

        test('includes example-driven format', () => {
            const prompt = buildSystemPrompt();
            assert.ok(prompt.includes('→'));
            assert.ok(prompt.includes('Bug Fixes'));
            assert.ok(prompt.includes('Logic Change'));
        });
    });

    suite('parseClassification', () => {
        test('returns the label as-is', () => {
            const result = parseClassification('Bug Fixes');
            assert.strictEqual(result, 'Bug Fixes');
        });

        test('trims whitespace', () => {
            const result = parseClassification('  Logic Change  ');
            assert.strictEqual(result, 'Logic Change');
        });

        test('takes first line only', () => {
            const result = parseClassification('Schema Design\nsome leftover');
            assert.strictEqual(result, 'Schema Design');
        });

        test('returns null for "(none)" marker', () => {
            assert.strictEqual(parseClassification('(none)'), null);
        });

        test('returns null for "Other" marker', () => {
            assert.strictEqual(parseClassification('Other'), null);
        });

        test('returns null for empty string', () => {
            assert.strictEqual(parseClassification(''), null);
        });

        test('returns null for whitespace-only string', () => {
            assert.strictEqual(parseClassification('   '), null);
        });

        // ── Rejection filters ─────────────────────────────────────────────

        test('rejects markdown code fence', () => {
            assert.strictEqual(parseClassification('```markdown'), null);
        });

        test('rejects markdown headings', () => {
            assert.strictEqual(parseClassification('## Work Plan Comparison'), null);
            assert.strictEqual(parseClassification('## MCP Server Feature Overview'), null);
        });

        test('rejects conversational responses', () => {
            assert.strictEqual(parseClassification('yes that makes sense'), null);
            assert.strictEqual(parseClassification('No I disagree'), null);
        });

        test('rejects refusal patterns', () => {
            assert.strictEqual(parseClassification('sorry i cannot assist'), null);
        });

        test('rejects sentences with more than 5 words', () => {
            assert.strictEqual(parseClassification('this is a sentence with many words'), null);
        });

        test('accepts up to 5 words', () => {
            const result = parseClassification('One Two Three Four Five');
            assert.strictEqual(result, 'One Two Three Four Five');
        });

        test('accepts multi-word category labels', () => {
            assert.strictEqual(parseClassification('Schema Design'), 'Schema Design');
            assert.strictEqual(parseClassification('Deployment Debug'), 'Deployment Debug');
            assert.strictEqual(parseClassification('Code Review'), 'Code Review');
        });
    });

    // ── Realistic chat fixture tests ──────────────────────────────────────
    // These test the full pipeline: buildClassificationPrompt + parseClassification
    // with realistic multi-turn conversations. They do NOT call the LLM API
    // (no model available in test env), so they verify the prompt-building and
    // parsing halves independently.

    suite('realistic chat fixtures', () => {
        function makeChatSession(title: string, turns: Array<{ role: 'user' | 'assistant'; content: string }>): Session {
            return {
                id: 'fixture-' + title.replace(/\s+/g, '-').toLowerCase(),
                title,
                source: 'copilot',
                workspaceId: 'ws1',
                messages: turns.map((t, i) => ({
                    id: `m${i}`,
                    role: t.role,
                    content: t.content,
                    codeBlocks: [],
                })),
                filePath: '/tmp/fixture.jsonl',
                createdAt: '2026-06-01T10:00:00Z',
                updatedAt: '2026-06-01T10:30:00Z',
            };
        }

        test('prompt for bug-fix session includes all turns', () => {
            const session = makeChatSession('Fix login crash', [
                { role: 'user', content: 'The login button crashes the app when clicked' },
                { role: 'assistant', content: 'Let me check the error. It looks like a null pointer in auth.ts line 42.' },
                { role: 'user', content: 'How do I fix that?' },
                { role: 'assistant', content: 'Add a null check before accessing the user object.' },
                { role: 'user', content: 'Thanks, that worked.' },
            ]);
            const prompt = buildClassificationPrompt(session);
            assert.ok(prompt.includes('Session title: Fix login crash'));
            assert.ok(prompt.includes('[USER]\nThe login button crashes'));
            assert.ok(prompt.includes('[ASSISTANT]\nAdd a null check'));
        });

        test('prompt for long session includes all messages', () => {
            const turns = Array.from({ length: 20 }, (_, i) => ({
                role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
                content: `Turn ${i} content here`,
            }));
            const session = makeChatSession('Long session', turns);
            const prompt = buildClassificationPrompt(session);
            assert.ok(prompt.includes('Turn 0 content'));
            assert.ok(prompt.includes('Turn 19 content'));
        });

        test('prompt for session with long messages preserves full content', () => {
            const session = makeChatSession('Long messages', [
                { role: 'user', content: 'a'.repeat(5000) },
                { role: 'assistant', content: 'b'.repeat(5000) },
            ]);
            const prompt = buildClassificationPrompt(session);
            assert.ok(prompt.includes('a'.repeat(5000)));
            assert.ok(prompt.includes('b'.repeat(5000)));
        });

        test('parseClassification rejects sentence-like LLM output from fixture', () => {
            // Simulate what the LLM might wrongly return for a bug-fix session
            const badOutputs = [
                '## Fix Login Crash',
                '```bug fix suggestion```',
                'yes the session is about fixing bugs',
                'sorry I cannot categorize this',
                'This session is about fixing a login crash in the authentication module',
            ];
            for (const out of badOutputs) {
                assert.strictEqual(parseClassification(out), null, `expected null for: "${out}"`);
            }
        });

        test('parseClassification accepts valid category labels', () => {
            const validLabels = [
                'Bug Fixes',
                'Logic Change',
                'New Features',
                'Schema Design',
                'Deployment Debug',
                'Code Review',
                'Auth',
                'Performance Tuning',
                'UI Polish',
                'Refactoring',
            ];
            for (const label of validLabels) {
                const result = parseClassification(label);
                assert.ok(result !== null, `expected non-null for: "${label}"`);
                // Must be ≤5 words
                assert.ok(result!.split(/\s+/).length <= 5, `expected ≤5 words for: "${label}"`);
            }
        });
    });
});