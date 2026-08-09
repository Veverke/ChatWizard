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

        test('does not truncate message content within limit', () => {
            const longContent = 'x'.repeat(10000);
            const session = makeSession({
                messages: [{ id: 'm0', role: 'user', content: longContent, codeBlocks: [] }],
            });
            const prompt = buildClassificationPrompt(session);
            // Full content preserved
            assert.ok(prompt.includes(longContent));
        });

        test('truncates messages exceeding MAX_CONVERSATION_CHARS', () => {
            // Create messages that total well over 24K chars
            const messages = Array.from({ length: 10 }, (_, i) => ({
                id: `m${i}`,
                role: 'user' as const,
                content: 'x'.repeat(5000),
                codeBlocks: [] as never[],
            }));
            const session = makeSession({ messages });
            const prompt = buildClassificationPrompt(session);
            // Total would be 10*5000 = 50K chars, so truncation must happen
            // The prompt should be under 30K total (header + truncated conversation)
            assert.ok(prompt.length < 30000, `prompt length was ${prompt.length}`);
            // The most recent messages should be preserved
            assert.ok(prompt.includes('[USER]\n' + 'x'.repeat(5000)));
        });

        test('truncation keeps newest messages, drops oldest', () => {
            const messages = Array.from({ length: 10 }, (_, i) => ({
                id: `m${i}`,
                role: 'user' as const,
                content: `Message number ${i} `.repeat(600), // ~10K chars each
                codeBlocks: [] as never[],
            }));
            const session = makeSession({ messages });
            const prompt = buildClassificationPrompt(session);
            // Newest messages (high indices) should be present
            assert.ok(prompt.includes('Message number 9'));
            // Oldest messages (low indices) may be dropped
            // At minimum the prompt should be under 30K
            assert.ok(prompt.length < 30000);
        });
    });

    suite('buildSystemPrompt', () => {
        test('includes activity-based categories like Bugs, Testing, Architecture', () => {
            const prompt = buildSystemPrompt();
            assert.ok(prompt.includes('session categorizer'));
            assert.ok(prompt.includes('Other'));
            assert.ok(prompt.includes('Bugs'));
            assert.ok(prompt.includes('Testing'));
            assert.ok(prompt.includes('Architecture'));
            assert.ok(prompt.includes('Refactoring'));
            assert.ok(prompt.includes('Features'));
            assert.ok(prompt.includes('Best Practices'));
        });
    });

    suite('parseClassification', () => {
        test('returns folder+subtype for pipe-separated input', () => {
            const r = parseClassification('Git|Branch Management');
            assert.ok(r !== null);
            assert.strictEqual(r!.folder, 'Git');
            assert.strictEqual(r!.subtype, 'Branch Management');
        });

        test('returns null for pipe-separated with Other top level', () => {
            assert.strictEqual(parseClassification('Other|Something'), null);
        });

        test('handles pipe with no second level (General omitted)', () => {
            const r = parseClassification('Git|General');
            assert.ok(r !== null);
            assert.strictEqual(r!.folder, 'Git');
            assert.strictEqual(r!.subtype, null);
        });

        test('returns folder as-is without pipe', () => {
            const result = parseClassification('Bug Fixes');
            assert.ok(result !== null);
            assert.strictEqual(result!.folder, 'Bug Fixes');
            assert.strictEqual(result!.subtype, null);
        });

        test('trims whitespace', () => {
            const result = parseClassification('  Logic Change  ');
            assert.ok(result !== null);
            assert.strictEqual(result!.folder, 'Logic Change');
            assert.strictEqual(result!.subtype, null);
        });

        test('takes first line only', () => {
            const result = parseClassification('Schema Design\nsome leftover');
            assert.ok(result !== null);
            assert.strictEqual(result!.folder, 'Schema Design');
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

        test('strips markdown code fences and extracts content', () => {
            checkPipeFence('```markdown\nSchema Design\n```', 'Schema Design', null);
            checkPipeFence('```\nBug Fixes\n```', 'Bug Fixes', null);
            checkPipeFence("```typescript\nGit|Branch Mgmt\n```", 'Git', 'Branch Mgmt');
        });

        function checkPipeFence(raw: string, expFolder: string, expSubtype: string | null) {
            const r = parseClassification(raw);
            assert.ok(r !== null, `expected non-null for: "${raw}"`);
            assert.strictEqual(r!.folder, expFolder);
            assert.strictEqual(r!.subtype, expSubtype);
        }

        test('strips fences with trailing text and takes first line', () => {
            const result = parseClassification("```markdown\nCode Review\n\nSome extra text\n```");
            assert.ok(result !== null);
            assert.strictEqual(result!.folder, 'Code Review');
        });

        test('strips unclosed fences (no closing ```)', () => {
            assert.strictEqual(parseClassification("```markdown\nSchema Design")!.folder, 'Schema Design');
            assert.strictEqual(parseClassification("```\nBug Fixes")!.folder, 'Bug Fixes');
            assert.strictEqual(parseClassification("```typescript\nLogic Change")!.folder, 'Logic Change');
        });

        test('strips unclosed fences with extra text after first line', () => {
            const result = parseClassification("```markdown\nCode Review\n\nSome extra text");
            assert.ok(result !== null);
            assert.strictEqual(result!.folder, 'Code Review');
        });

        test('rejects "Sorry," with comma (refusal variant)', () => {
            assert.strictEqual(parseClassification("Sorry, I can't assist with that."), null);
        });

        test('rejects markdown headings', () => {
            assert.strictEqual(parseClassification('## Work Plan Comparison'), null);
            assert.strictEqual(parseClassification('## MCP Server Feature Overview'), null);
        });

        test('rejects JS/TS code statements', () => {
            assert.strictEqual(parseClassification('let showTimer = null;'), null);
            assert.strictEqual(parseClassification('const x = 5;'), null);
            assert.strictEqual(parseClassification('var foo = "bar"'), null);
            assert.strictEqual(parseClassification('function doSomething()'), null);
            assert.strictEqual(parseClassification('if (x > 0) {'), null);
        });

        test('rejects Mermaid diagram declarations', () => {
            assert.strictEqual(parseClassification('graph TD;'), null);
            assert.strictEqual(parseClassification('graph LR:'), null);
            assert.strictEqual(parseClassification('sequenceDiagram'), null);
        });

        test('rejects code comment output', () => {
            assert.strictEqual(parseClassification('// ── rebuild-native.js ──'), null);
            assert.strictEqual(parseClassification('// This is a comment'), null);
        });

        test('rejects markdown link output', () => {
            assert.strictEqual(parseClassification('[VS Code Marketplace]'), null);
            assert.strictEqual(parseClassification('[X] Completed'), null);
            assert.strictEqual(parseClassification('[!NOTE]'), null);
        });

        test('rejects conversational responses', () => {
            assert.strictEqual(parseClassification('yes that makes sense'), null);
            assert.strictEqual(parseClassification('No I disagree'), null);
        });

        test('rejects refusal patterns', () => {
            assert.strictEqual(parseClassification('sorry i cannot assist'), null);
        });

        test('rejects emoji-prefixed output', () => {
            assert.strictEqual(parseClassification('✅ COMPLETED'), null);
            assert.strictEqual(parseClassification('❌ Failed'), null);
            assert.strictEqual(parseClassification('⚠️ Warning'), null);
            assert.strictEqual(parseClassification('🔴 Error'), null);
        });

        test('rejects sentences with more than 2 words (pipe-less)', () => {
            assert.strictEqual(parseClassification('this is a sentence with many words'), null);
        });

        test('accepts up to 2 words as folder (pipe-less)', () => {
            const result = parseClassification('One Two');
            assert.ok(result !== null);
            assert.strictEqual(result!.folder, 'One Two');
            assert.strictEqual(result!.subtype, null);
        });

        test('accepts multi-word pipe output with up to 3 words second level', () => {
            const r = parseClassification('Bugs|UI Crash Pattern');
            assert.ok(r !== null);
            assert.strictEqual(r!.folder, 'Bugs');
            assert.strictEqual(r!.subtype, 'UI Crash Pattern');
        });

        test('accepts multi-word category labels without pipe', () => {
            assert.strictEqual(parseClassification('Schema Design')!.folder, 'Schema Design');
            assert.strictEqual(parseClassification('Deployment Debug')!.folder, 'Deployment Debug');
            assert.strictEqual(parseClassification('Code Review')!.folder, 'Code Review');
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

        test('prompt includes inline classification instructions', () => {
            const session = makeChatSession('Fix login crash', [
                { role: 'user', content: 'The login button crashes' },
            ]);
            const prompt = buildClassificationPrompt(session);
            // Instructions are embedded inline (not systemPrompt) so the model always sees them
            assert.ok(prompt.includes('You are a session categorizer'));
            assert.ok(prompt.includes('TopLevel|SecondLevel'));
            assert.ok(prompt.includes('=== CONVERSATION ==='));
            assert.ok(prompt.includes('Title Case'));
        });

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
                'yes the session is about fixing bugs',
                'sorry I cannot categorize this',
                'This session is about fixing a login crash in the authentication module',
            ];
            for (const out of badOutputs) {
                assert.strictEqual(parseClassification(out), null, `expected null for: "${out}"`);
            }
        });

        test('parseClassification extracts valid category from inline code fence', () => {
            // The LLM sometimes wraps a short category in an inline code fence
            // (no line breaks). The parser should strip the fences and accept it.
            const r = parseClassification('```bug fix suggestion```');
            assert.ok(r != null);
            assert.strictEqual(r.folder, 'fix suggestion');
            assert.strictEqual(r.subtype, null);
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
                // Must be ≤2 words for pipe-less (backward compat)
                assert.ok(result!.folder.split(/\s+/).length <= 2, `expected ≤2 words for: "${label}"`);
            }
        });
    });

    // ── Regression: leaky outputs from production log ────────────────────
    // These are actual LLM outputs that passed through the old code (v1.6.0
    // with only 2 REJECT_PATTERNS) and were logged as INFO "Classified".
    // Every one must be rejected by the current parser.
    suite('regression — leaky outputs from production log', () => {
        // Mermaid diagram syntax
        test('rejects "graph TD;"', () => {
            assert.strictEqual(parseClassification('graph TD;'), null);
        });

        // Code comment with em-dashes
        test('rejects "// ── rebuild-native.js ──"', () => {
            assert.strictEqual(parseClassification('// ── rebuild-native.js ────────────────────────────────────────────────'), null);
        });

        // Single # heading
        test('rejects "# Summary of Updates"', () => {
            assert.strictEqual(parseClassification('# Summary of Updates'), null);
        });

        test('rejects "# Changelog"', () => {
            assert.strictEqual(parseClassification('# Changelog'), null);
        });

        test('rejects "# Chat Wizard"', () => {
            assert.strictEqual(parseClassification('# Chat Wizard'), null);
        });

        test('rejects "# Extension Features Overview"', () => {
            assert.strictEqual(parseClassification('# Extension Features Overview'), null);
        });

        test('rejects "# ChatWizard Release Work Plan"', () => {
            assert.strictEqual(parseClassification('# ChatWizard Release Work Plan'), null);
        });

        test('rejects "# Phase 2 Implementation Summary"', () => {
            assert.strictEqual(parseClassification('# Phase 2 Implementation Summary'), null);
        });

        // Markdown link with badge image
        test('rejects "[![VS Code Marketplace]..." badge link', () => {
            const mdLink = '[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/Veverke.chatwizard?label=VS%20Code%20Marketplace&logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=Veverke.chatwizard)';
            assert.strictEqual(parseClassification(mdLink), null);
        });

        // JS declaration
        test('rejects "let showTimer = null;"', () => {
            assert.strictEqual(parseClassification('let showTimer = null;'), null);
        });

        // Code comment about search fix
        test('rejects "// Search fix implementation"', () => {
            assert.strictEqual(parseClassification('// Search fix implementation'), null);
        });

        // Emoji-prefixed output
        test('rejects "✅ COMPLETED"', () => {
            assert.strictEqual(parseClassification('✅ COMPLETED'), null);
        });

        // ## heading
        test('rejects "## Work Plan Comparison"', () => {
            assert.strictEqual(parseClassification('## Work Plan Comparison'), null);
        });
    });
});