// test/e2e/sessionCostAdvisor.test.ts
//
// Unit tests for SessionCostAdvisor (Feature 20-I).
// Uses a mock ConsolidateFn to isolate the advisor from real LLM calls.
// Tests cover real-world multi-turn conversations, savings thresholds,
// numerical correctness, and edge cases.

import * as assert from 'assert';
import { SessionCostAdvisor, AdviseTurn, CostAdvice } from '../../src/analytics/sessionCostAdvisor';
import type { ConsolidateFn } from '../../src/analytics/sessionCostAdvisor';
import { PRICE_TABLE } from '../../src/utils/modelPriceTable';
import { countTokens } from '../../src/utils/tokenizer';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConsolidator(prompt: string, tokenCount: number): ConsolidateFn {
    return async () => ({ consolidatedPrompt: prompt, consolidatedTokenCount: tokenCount, intentCount: 2 });
}

function nullConsolidator(): ConsolidateFn {
    return async () => null;
}

// Build AdviseTurn[] with uniform model across all turns
function buildTurns(
    pairs: Array<[string, string]>,
    modelId: AdviseTurn['modelId'] = 'claude-3-5-sonnet',
): AdviseTurn[] {
    return pairs.map(([u, a]) => ({ userText: u, assistantText: a, modelId }));
}

// ── Suite ────────────────────────────────────────────────────────────────────

suite('SessionCostAdvisor', () => {

    // ── Null cases ──────────────────────────────────────────────────────────

    test('returns null for 0 turns', async () => {
        const advisor = new SessionCostAdvisor(makeConsolidator('x', 1));
        assert.strictEqual(await advisor.advise([]), null);
    });

    test('returns null for a single turn', async () => {
        const advisor = new SessionCostAdvisor(makeConsolidator('x', 1));
        const turns = buildTurns([['Explain async/await in JavaScript.', 'Async/await is syntactic sugar over Promises...']]);
        assert.strictEqual(await advisor.advise(turns), null);
    });

    test('returns null when consolidator returns null', async () => {
        const advisor = new SessionCostAdvisor(nullConsolidator());
        const turns = buildTurns([
            ['Fix the login bug.', 'Here is the fix...'],
            ['Add tests.', 'Here are the tests...'],
        ]);
        assert.strictEqual(await advisor.advise(turns), null);
    });

    test('returns null when savings < $0.001 (below noise floor)', async () => {
        // Tiny session: 10 tokens each side, consolidated to 8 tokens
        // At gpt-4o-mini rates this will be far below $0.001 in savings
        const smallTurns = buildTurns(
            [
                ['Hi', 'Hello'],
                ['Bye', 'Goodbye'],
            ],
            'gpt-4o-mini',
        );
        // Even if we consolidate to 1 token the total cost is so small savings < $0.001
        const advisor = new SessionCostAdvisor(makeConsolidator('Hi. Bye.', 3));
        assert.strictEqual(await advisor.advise(smallTurns), null);
    });

    // ── Real-world scenario: 5-turn refactoring session on Claude 3.5 Sonnet ─

    test('realistic 5-turn session produces advice with positive savings', async () => {
        const turns = buildTurns([
            [
                'Can you help me refactor the authentication module in my Express app? It\'s getting too large.',
                'Sure! I\'ll start by extracting the token validation logic into a separate TokenService class. Here is the refactored code:\n\n```typescript\nclass TokenService {\n  verify(token: string) { /* ... */ }\n}\n```',
            ],
            [
                'Also, can you add password hashing using bcrypt to the UserService?',
                'I\'ll add bcrypt to the UserService. Install with: npm install bcrypt @types/bcrypt\n\n```typescript\nimport bcrypt from \'bcrypt\';\nconst hashed = await bcrypt.hash(password, 12);\n```',
            ],
            [
                'Please also write unit tests for both the TokenService and UserService.',
                'Here are the unit tests using Vitest:\n\n```typescript\ndescribe(\'TokenService\', () => {\n  test(\'verifies valid token\', () => { /* ... */ });\n});\n```',
            ],
            [
                'Update the README with the new architecture.',
                'I\'ve updated the README:\n\n## Architecture\n\n- `TokenService`: handles JWT verification\n- `UserService`: manages user data and password hashing',
            ],
            [
                'Can you add a rate limiter middleware to protect the login endpoint?',
                'Install express-rate-limit: npm install express-rate-limit\n\n```typescript\nimport rateLimit from \'express-rate-limit\';\nconst loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 });\n```',
            ],
        ], 'claude-3-5-sonnet');

        const consolidatedPrompt =
            'Refactor Express auth module: extract TokenService with JWT verification, ' +
            'add bcrypt password hashing to UserService, write unit tests for both, ' +
            'update README with new architecture, add rate limiter to login endpoint.';

        const advisor = new SessionCostAdvisor(
            makeConsolidator(consolidatedPrompt, countTokens(consolidatedPrompt)),
        );
        const advice = await advisor.advise(turns);

        assert.ok(advice, 'Expected advice for a realistic 5-turn session');
        assert.ok(advice.savingsUsd > 0, 'Expected positive savings');
        assert.ok(advice.savingsPct > 0 && advice.savingsPct <= 100);
        assert.ok(advice.cumulativeCostUsd > advice.consolidatedCostUsd,
            'Actual cost should exceed consolidated cost');
        assert.strictEqual(advice.turnCount, 5);
        assert.strictEqual(advice.consolidatedPrompt, consolidatedPrompt);
    });

    // ── Numerical correctness ───────────────────────────────────────────────

    test('savingsPct is computed correctly', async () => {
        // Engineer the scenario so we know exact numbers
        // Use addTurnTokens-equivalent: 10000 input, 5000 output on gpt-4o
        // Then consolidated = 500 input + avgAssistant output
        const turns = buildTurns(
            [
                ['a'.repeat(40000), 'b'.repeat(20000)],
                ['c'.repeat(40000), 'd'.repeat(20000)],
            ],
            'gpt-4o',
        );

        const price = PRICE_TABLE['gpt-4o'];
        // Actual cost ≈ (80000+40000)/1M * input + (40000+40000)/1M * output
        // That's going to be a real number; let's just check the relationship
        const consolidatedTokens = 100; // tiny consolidated prompt
        const advisor = new SessionCostAdvisor(makeConsolidator('x'.repeat(400), consolidatedTokens));
        const advice = await advisor.advise(turns);
        assert.ok(advice, 'Expected advice for large turns');

        const manualPct = Math.round((advice.savingsUsd / advice.cumulativeCostUsd) * 100);
        assert.strictEqual(advice.savingsPct, Math.min(100, manualPct));
    });

    test('consolidatedCostUsd uses average assistant token count as proxy', async () => {
        // Use large messages so total cost is well above $0.001 savings threshold.
        // 2 turns on gpt-4o: user = 5000 chars (~1250 tokens), assistant = 20000 chars (~5000 tokens)
        const price = PRICE_TABLE['gpt-4o'];

        const turns: AdviseTurn[] = [
            { userText: 'x'.repeat(5000), assistantText: 'y'.repeat(20000), modelId: 'gpt-4o' },
            { userText: 'x'.repeat(5000), assistantText: 'y'.repeat(40000), modelId: 'gpt-4o' },
        ];
        const asst1Toks = countTokens('y'.repeat(20000));
        const asst2Toks = countTokens('y'.repeat(40000));
        const avgAsst   = Math.ceil((asst1Toks + asst2Toks) / 2);
        const consolidatedToks = 50;

        const expectedConsolidatedCost =
            (consolidatedToks / 1_000_000) * price.inputUsdPerMillion +
            (avgAsst          / 1_000_000) * price.outputUsdPerMillion;

        const advisor = new SessionCostAdvisor(makeConsolidator('x'.repeat(200), consolidatedToks));
        const advice  = await advisor.advise(turns);

        assert.ok(advice, 'Expected advice for large turns with meaningful savings');
        assert.ok(
            Math.abs(advice.consolidatedCostUsd - expectedConsolidatedCost) < 1e-9,
            `Expected consolidatedCostUsd ≈ ${expectedConsolidatedCost}, got ${advice.consolidatedCostUsd}`,
        );
    });

    // ── Raw model string resolution ─────────────────────────────────────────

    test('raw model name string is resolved to ModelId', async () => {
        const turns: AdviseTurn[] = [
            {
                userText: 'What is dependency injection?',
                assistantText: 'Dependency injection is a pattern where dependencies are passed into a class rather than created inside it.',
                modelId: 'claude-sonnet-4-5', // raw alias
            },
            {
                userText: 'Show me a TypeScript example.',
                assistantText: 'Here is an example:\n```typescript\nclass Service { constructor(private repo: Repo) {} }\n```',
                modelId: 'claude-sonnet-4-5',
            },
        ];

        const advisor = new SessionCostAdvisor(
            makeConsolidator('Explain DI with TypeScript example.', 10),
        );
        // Should not throw even with a raw model alias
        const advice = await advisor.advise(turns);
        // Either null (savings too small) or a valid CostAdvice
        if (advice) {
            assert.ok(typeof advice.cumulativeCostUsd === 'number');
            assert.ok(typeof advice.savingsUsd === 'number');
        }
    });

    // ── savingsPct boundary: capped at 100 ─────────────────────────────────

    test('savingsPct is capped at 100 even if consolidatedCostUsd were negative (edge case)', async () => {
        // Consolidator returns 0 tokens → savingsUsd > cumulativeCostUsd
        const bigTurns = buildTurns([
            ['a'.repeat(40000), 'b'.repeat(40000)],
            ['c'.repeat(40000), 'd'.repeat(40000)],
        ], 'gpt-4o');

        const advisor = new SessionCostAdvisor(async () => ({
            consolidatedPrompt: 'x',
            consolidatedTokenCount: 1,
            intentCount: 2,
        }));
        const advice = await advisor.advise(bigTurns);
        if (advice) {
            assert.ok(advice.savingsPct <= 100, `savingsPct ${advice.savingsPct} should be ≤ 100`);
        }
    });

    // ── Consolidator errors are propagated ─────────────────────────────────

    test('advisor returns null when consolidator throws', async () => {
        const advisor = new SessionCostAdvisor(async () => { throw new Error('LLM unavailable'); });
        const turns = buildTurns([
            ['Explain React hooks.', 'React hooks are functions that let you use state in functional components.'],
            ['Show me useState.', 'const [count, setCount] = useState(0);'],
        ]);
        // Advisor should catch the error and return null
        const advice = await advisor.advise(turns);
        assert.strictEqual(advice, null);
    });

});
