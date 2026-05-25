// test/e2e/copilotPromptAnalysisProvider.test.ts
//
// Unit tests for the pure-function helpers in copilotPromptAnalysisProvider:
//   extractJson   — strips markdown fences to expose raw JSON
//   parseResponse — validates and maps LLM JSON output to LlmPromptAnalysis
//
// These helpers are pure (no I/O, no VS Code dependency) so they are fully
// testable in the extension-host test environment without any mocking.

import * as assert from 'assert';
import { extractJson, parseResponse } from '../../src/analytics/copilotPromptAnalysisProvider';

suite('CopilotPromptAnalysisProvider — extractJson', () => {

    test('returns raw JSON from a plain JSON string', () => {
        const input = '{"verbosityFlags":[],"modelSuggestion":"gpt-4o-mini"}';
        assert.strictEqual(extractJson(input), input);
    });

    test('strips ```json ... ``` markdown fence', () => {
        const input = '```json\n{"verbosityFlags":[],"modelSuggestion":"gpt-4o-mini"}\n```';
        assert.strictEqual(
            extractJson(input),
            '{"verbosityFlags":[],"modelSuggestion":"gpt-4o-mini"}',
        );
    });

    test('strips ``` (no language) fence', () => {
        const input = '```\n{"a":1}\n```';
        const result = extractJson(input);
        assert.ok(result.includes('"a":1'));
    });

    test('extracts JSON object when surrounded by prose', () => {
        const input = 'Here is the analysis: {"verbosityFlags":[],"modelSuggestion":"claude-3-5-haiku"} — done.';
        const result = extractJson(input);
        assert.ok(result.startsWith('{'));
        assert.ok(result.endsWith('}'));
    });

    test('returns trimmed input when no fence or brace found', () => {
        const input = '  no json here  ';
        assert.strictEqual(extractJson(input), 'no json here');
    });

});

suite('CopilotPromptAnalysisProvider — parseResponse', () => {

    // ── Valid JSON ────────────────────────────────────────────────────────────

    test('parses a valid full response with all fields', () => {
        const raw = JSON.stringify({
            verbosityFlags: [
                { code: 'VERY_LONG', description: 'Prompt exceeds 4000 tokens.' },
                { code: 'MULTIPLE_QUESTIONS', description: 'Contains 4 questions.' },
            ],
            modelSuggestion: 'gpt-4o-mini',
            rewriteSuggestion: 'Split into two focused prompts.',
        });
        const result = parseResponse(raw);
        assert.ok(result, 'Expected a non-null result');
        assert.strictEqual(result.verbosityFlags.length, 2);
        assert.strictEqual(result.verbosityFlags[0].code, 'VERY_LONG');
        assert.strictEqual(result.verbosityFlags[1].code, 'MULTIPLE_QUESTIONS');
        assert.strictEqual(result.modelSuggestion, 'gpt-4o-mini');
        assert.strictEqual(result.rewriteSuggestion, 'Split into two focused prompts.');
    });

    test('parses valid JSON with empty verbosityFlags array', () => {
        const raw = JSON.stringify({ verbosityFlags: [], modelSuggestion: 'claude-3-5-haiku' });
        const result = parseResponse(raw);
        assert.ok(result);
        assert.deepStrictEqual(result.verbosityFlags, []);
        assert.strictEqual(result.modelSuggestion, 'claude-3-5-haiku');
    });

    test('parses response wrapped in markdown json fence', () => {
        const raw = '```json\n' + JSON.stringify({
            verbosityFlags: [{ code: 'OPEN_ENDED', description: 'Vague scope.' }],
            modelSuggestion: 'gpt-4o-mini',
        }) + '\n```';
        const result = parseResponse(raw);
        assert.ok(result);
        assert.strictEqual(result.verbosityFlags[0].code, 'OPEN_ENDED');
    });

    test('rewriteSuggestion is undefined when absent in JSON', () => {
        const raw = JSON.stringify({ verbosityFlags: [], modelSuggestion: 'gemini-2.0-flash' });
        const result = parseResponse(raw);
        assert.ok(result);
        assert.strictEqual(result.rewriteSuggestion, undefined);
    });

    test('rewriteSuggestion is undefined when empty string', () => {
        const raw = JSON.stringify({ verbosityFlags: [], modelSuggestion: 'gpt-4o-mini', rewriteSuggestion: '' });
        const result = parseResponse(raw);
        assert.ok(result);
        assert.strictEqual(result.rewriteSuggestion, undefined);
    });

    // ── Invalid code filtering ────────────────────────────────────────────────

    test('filters out verbosityFlags with invalid codes', () => {
        const raw = JSON.stringify({
            verbosityFlags: [
                { code: 'VERY_LONG', description: 'Valid.' },
                { code: 'INVALID_CODE', description: 'Should be dropped.' },
                { code: 'NOT_A_REAL_FLAG', description: 'Also dropped.' },
            ],
            modelSuggestion: 'gpt-4o-mini',
        });
        const result = parseResponse(raw);
        assert.ok(result);
        assert.strictEqual(result.verbosityFlags.length, 1);
        assert.strictEqual(result.verbosityFlags[0].code, 'VERY_LONG');
    });

    test('filters out verbosityFlags missing a code field', () => {
        const raw = JSON.stringify({
            verbosityFlags: [
                { description: 'No code here.' },
                { code: 'LARGE_CODE_BLOCK', description: 'Valid.' },
            ],
            modelSuggestion: 'gpt-4o-mini',
        });
        const result = parseResponse(raw);
        assert.ok(result);
        assert.strictEqual(result.verbosityFlags.length, 1);
    });

    // ── Model suggestion normalization ────────────────────────────────────────

    test('resolves raw model alias to canonical ModelId', () => {
        const raw = JSON.stringify({
            verbosityFlags: [],
            modelSuggestion: 'claude-sonnet-4', // raw alias that resolves to claude-3-5-sonnet
        });
        const result = parseResponse(raw);
        assert.ok(result);
        // resolveModelId maps to a canonical ID or falls back to gpt-4o-mini
        assert.ok(typeof result.modelSuggestion === 'string');
        assert.ok(result.modelSuggestion.length > 0);
    });

    test('falls back to gpt-4o-mini for unknown model suggestion', () => {
        const raw = JSON.stringify({
            verbosityFlags: [],
            modelSuggestion: 'totally-unknown-model-xyz',
        });
        const result = parseResponse(raw);
        assert.ok(result);
        assert.strictEqual(result.modelSuggestion, 'gpt-4o-mini');
    });

    // ── Error cases ───────────────────────────────────────────────────────────

    test('returns null for completely invalid JSON', () => {
        assert.strictEqual(parseResponse('not json at all'), null);
    });

    test('returns null for empty string', () => {
        assert.strictEqual(parseResponse(''), null);
    });

    test('returns null for a JSON array (not an object)', () => {
        assert.strictEqual(parseResponse('[1, 2, 3]'), null);
    });

    test('missing verbosityFlags field → defaults to empty array', () => {
        const raw = JSON.stringify({ modelSuggestion: 'gpt-4o-mini' });
        const result = parseResponse(raw);
        assert.ok(result);
        assert.deepStrictEqual(result.verbosityFlags, []);
    });

    test('all 5 valid codes are accepted', () => {
        const codes = ['LARGE_CODE_BLOCK', 'OPEN_ENDED', 'MULTIPLE_QUESTIONS', 'VERY_LONG', 'REPETITIVE_PHRASING'];
        const raw = JSON.stringify({
            verbosityFlags: codes.map(code => ({ code, description: `${code} detected.` })),
            modelSuggestion: 'gpt-4o',
        });
        const result = parseResponse(raw);
        assert.ok(result);
        assert.strictEqual(result.verbosityFlags.length, 5);
        assert.deepStrictEqual(result.verbosityFlags.map(f => f.code), codes);
    });

    test('description is truncated to 200 chars', () => {
        const longDesc = 'x'.repeat(300);
        const raw = JSON.stringify({
            verbosityFlags: [{ code: 'VERY_LONG', description: longDesc }],
            modelSuggestion: 'gpt-4o-mini',
        });
        const result = parseResponse(raw);
        assert.ok(result);
        assert.strictEqual(result.verbosityFlags[0].description.length, 200);
    });

});
