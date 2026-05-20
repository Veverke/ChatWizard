// test/e2e/promptAnalyzer.test.ts
import * as assert from 'assert';
import { PromptAnalyzer } from '../../src/analytics/promptAnalyzer';

suite('PromptAnalyzer', () => {

    const analyzer = new PromptAnalyzer();

    test('detects VERY_LONG flag for long prompt', async () => {
        const longText = 'word '.repeat(600);
        const result = await analyzer.analyze(longText);
        assert.ok(result.verbosityFlags.some(f => f.code === 'VERY_LONG'));
    });

    test('detects LARGE_CODE_BLOCK flag', async () => {
        const code = '```typescript\n' + 'const x = 1;\n'.repeat(60) + '```';
        const result = await analyzer.analyze(code);
        assert.ok(result.verbosityFlags.some(f => f.code === 'LARGE_CODE_BLOCK'));
    });

    test('detects MULTIPLE_QUESTIONS', async () => {
        const text = 'What is X? How does Y work? Why did Z fail? Can you explain A?';
        const result = await analyzer.analyze(text);
        assert.ok(result.verbosityFlags.some(f => f.code === 'MULTIPLE_QUESTIONS'));
    });

    test('returns token count and cost estimate', async () => {
        const result = await analyzer.analyze('Hello world, this is a short prompt.');
        assert.ok(typeof result.tokenCount === 'number');
        assert.ok(result.tokenCount > 0);
        assert.ok(Array.isArray(result.costEstimates));
    });

    test('returns no flags for a clean short prompt', async () => {
        const result = await analyzer.analyze('What is the purpose of async/await in TypeScript?');
        assert.ok(!result.verbosityFlags.some(f => f.code === 'VERY_LONG'));
        assert.ok(!result.verbosityFlags.some(f => f.code === 'LARGE_CODE_BLOCK'));
    });

    test('suggestModel returns a valid model id', async () => {
        const result = await analyzer.analyze('Summarise this in one sentence.');
        assert.ok(typeof result.suggestedModel === 'string');
        assert.ok(result.suggestedModel.length > 0);
    });

});
