// test/e2e/promptAnalyzer.test.ts
import * as assert from 'assert';
import { PromptAnalyzer, ILlmAnalysisProvider, LlmPromptAnalysis } from '../../src/analytics/promptAnalyzer';

// ── Mock LLM providers ──────────────────────────────────────────────────────

/** Returns a fixed analysis result — simulates a real Copilot LLM response */
class MockLlmProvider implements ILlmAnalysisProvider {
    constructor(private result: LlmPromptAnalysis | null) {}
    async analyze(): Promise<LlmPromptAnalysis | null> { return this.result; }
}

/** Always throws — simulates LLM API unavailability */
class ThrowingLlmProvider implements ILlmAnalysisProvider {
    async analyze(): Promise<LlmPromptAnalysis | null> { throw new Error('LLM unavailable'); }
}


suite('PromptAnalyzer', () => {

    const analyzer = new PromptAnalyzer();

    test('detects VERY_LONG flag for long prompt', async () => {
        // ~3300 words × 5 chars = 16 500 chars → countTokens returns ⌈16500/4⌉ = 4125 > 4000
        const longText = 'word '.repeat(3300);
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

// ── LLM provider path ───────────────────────────────────────────────────────

suite('PromptAnalyzer — LLM provider path', () => {

    test('analysisSource is "llm" when provider returns a result', async () => {
        const llmResult: LlmPromptAnalysis = {
            verbosityFlags: [
                { code: 'OPEN_ENDED', description: 'Open-ended question detected.' },
                { code: 'MULTIPLE_QUESTIONS', description: 'Multiple questions detected.' },
            ],
            modelSuggestion: 'gpt-4o-mini',
            rewriteSuggestion: 'Focus on a single specific question.',
        };
        const analyzer = new PromptAnalyzer(undefined, new MockLlmProvider(llmResult));
        const analysis = await analyzer.analyze('What is X? Why is Y? How does Z work?');
        assert.strictEqual(analysis.analysisSource, 'llm');
        assert.ok(analysis.verbosityFlags.some(f => f.code === 'OPEN_ENDED'));
        assert.ok(analysis.verbosityFlags.some(f => f.code === 'MULTIPLE_QUESTIONS'));
        assert.strictEqual(analysis.rewriteSuggestion, 'Focus on a single specific question.');
    });

    test('analysisSource is "heuristic" when provider returns null', async () => {
        const analyzer = new PromptAnalyzer(undefined, new MockLlmProvider(null));
        const result = await analyzer.analyze('What is async/await?');
        assert.strictEqual(result.analysisSource, 'heuristic');
        assert.strictEqual(result.rewriteSuggestion, undefined);
    });

    test('analysisSource is "heuristic" when provider throws', async () => {
        const analyzer = new PromptAnalyzer(undefined, new ThrowingLlmProvider());
        const result = await analyzer.analyze('Show me a React hook example.');
        assert.strictEqual(result.analysisSource, 'heuristic');
    });

    test('rewriteSuggestion absent when provider returns null', async () => {
        const analyzer = new PromptAnalyzer(undefined, new MockLlmProvider(null));
        const result = await analyzer.analyze('Explain closures in JavaScript.');
        assert.strictEqual(result.rewriteSuggestion, undefined);
    });

    test('LLM verbosity flags are included in result.verbosityFlags array', async () => {
        const llmResult: LlmPromptAnalysis = {
            verbosityFlags: [
                { code: 'VERY_LONG', description: 'Prompt is very long.' },
                { code: 'REPETITIVE_PHRASING', description: 'Repetitive phrasing detected.' },
            ],
            modelSuggestion: 'claude-3-5-haiku',
        };
        const analyzer = new PromptAnalyzer(undefined, new MockLlmProvider(llmResult));
        const analysis = await analyzer.analyze('word '.repeat(2000));
        const codes = analysis.verbosityFlags.map(f => f.code);
        assert.ok(codes.includes('VERY_LONG'), `Expected VERY_LONG in ${codes.join(', ')}`);
        assert.ok(codes.includes('REPETITIVE_PHRASING'), `Expected REPETITIVE_PHRASING in ${codes.join(', ')}`);
    });

    test('LLM model suggestion used as suggestedModel', async () => {
        const llmResult: LlmPromptAnalysis = {
            verbosityFlags: [],
            modelSuggestion: 'gpt-4o-mini',
        };
        const analyzer = new PromptAnalyzer(undefined, new MockLlmProvider(llmResult));
        const analysis = await analyzer.analyze('Summarise this document for me.');
        assert.strictEqual(analysis.suggestedModel, 'gpt-4o-mini');
    });

    test('heuristic fallback still flags VERY_LONG on long prompt', async () => {
        const analyzer = new PromptAnalyzer(undefined, new ThrowingLlmProvider());
        const result = await analyzer.analyze('word '.repeat(3300));
        assert.ok(result.verbosityFlags.some(f => f.code === 'VERY_LONG'));
        assert.strictEqual(result.analysisSource, 'heuristic');
    });

    test('no provider → analysisSource is "heuristic"', async () => {
        const analyzer = new PromptAnalyzer();
        const result = await analyzer.analyze('Explain React hooks.');
        assert.strictEqual(result.analysisSource, 'heuristic');
    });

});
