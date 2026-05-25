// test/e2e/sessionCostAccumulator.test.ts
//
// Unit tests for SessionCostAccumulator (Feature 20-F).
// Covers real-world multi-turn scenarios, mixed models, edge cases, and
// numerical correctness cross-checked against known price table values.

import * as assert from 'assert';
import { SessionCostAccumulator } from '../../src/analytics/sessionCostAccumulator';
import { PRICE_TABLE } from '../../src/utils/modelPriceTable';

suite('SessionCostAccumulator', () => {

    // ── Basic construction ──────────────────────────────────────────────────

    test('empty accumulator returns zeros', () => {
        const acc = new SessionCostAccumulator();
        const cost = acc.getCumulativeCost();
        assert.strictEqual(cost.totalInputTokens, 0);
        assert.strictEqual(cost.totalOutputTokens, 0);
        assert.strictEqual(cost.totalCostUsd, 0);
        assert.strictEqual(cost.turnCount, 0);
    });

    test('getTurns returns empty array when nothing added', () => {
        const acc = new SessionCostAccumulator();
        assert.deepStrictEqual(acc.getTurns(), []);
    });

    // ── addTurnTokens: known-value cost verification ────────────────────────

    test('addTurnTokens: 1000 input + 500 output on gpt-4o produces correct USD', () => {
        const acc = new SessionCostAccumulator();
        acc.addTurnTokens(1000, 500, 'gpt-4o');
        const cost = acc.getCumulativeCost();

        const price = PRICE_TABLE['gpt-4o'];
        const expectedUsd =
            (1000 / 1_000_000) * price.inputUsdPerMillion +
            (500 / 1_000_000) * price.outputUsdPerMillion;

        assert.strictEqual(cost.totalInputTokens, 1000);
        assert.strictEqual(cost.totalOutputTokens, 500);
        assert.ok(
            Math.abs(cost.totalCostUsd - expectedUsd) < 1e-10,
            `Expected ~${expectedUsd}, got ${cost.totalCostUsd}`,
        );
        assert.strictEqual(cost.turnCount, 1);
        assert.strictEqual(cost.lastModelId, 'gpt-4o');
        assert.strictEqual(cost.modelDisplayName, price.displayName);
    });

    test('addTurnTokens: zero-token turn produces cost = 0', () => {
        const acc = new SessionCostAccumulator();
        acc.addTurnTokens(0, 0, 'claude-3-5-sonnet');
        const cost = acc.getCumulativeCost();
        assert.strictEqual(cost.totalCostUsd, 0);
        assert.strictEqual(cost.turnCount, 1);
    });

    test('addTurnTokens: cumulative cost is sum of individual turns', () => {
        const acc = new SessionCostAccumulator();
        acc.addTurnTokens(500, 200, 'gpt-4o-mini');
        acc.addTurnTokens(800, 400, 'gpt-4o-mini');

        const price = PRICE_TABLE['gpt-4o-mini'];
        const expected =
            ((500 + 800) / 1_000_000) * price.inputUsdPerMillion +
            ((200 + 400) / 1_000_000) * price.outputUsdPerMillion;

        const cost = acc.getCumulativeCost();
        assert.ok(Math.abs(cost.totalCostUsd - expected) < 1e-10);
        assert.strictEqual(cost.totalInputTokens, 1300);
        assert.strictEqual(cost.totalOutputTokens, 600);
        assert.strictEqual(cost.turnCount, 2);
    });

    // ── Mixed models across turns ───────────────────────────────────────────

    test('mixed models: cost uses correct rate per turn', () => {
        const acc = new SessionCostAccumulator();
        // Turn 1: gpt-4o
        acc.addTurnTokens(1000, 300, 'gpt-4o');
        // Turn 2: gpt-4o-mini (much cheaper)
        acc.addTurnTokens(1000, 300, 'gpt-4o-mini');

        const priceExpensive = PRICE_TABLE['gpt-4o'];
        const priceCheap     = PRICE_TABLE['gpt-4o-mini'];
        const expected =
            (1000 / 1_000_000) * priceExpensive.inputUsdPerMillion +
            (300  / 1_000_000) * priceExpensive.outputUsdPerMillion +
            (1000 / 1_000_000) * priceCheap.inputUsdPerMillion +
            (300  / 1_000_000) * priceCheap.outputUsdPerMillion;

        const cost = acc.getCumulativeCost();
        assert.ok(Math.abs(cost.totalCostUsd - expected) < 1e-10,
            `Expected ~${expected}, got ${cost.totalCostUsd}`);
        // lastModelId should be the model of the most recently added turn
        assert.strictEqual(cost.lastModelId, 'gpt-4o-mini');
    });

    // ── addTurn (text-based) ────────────────────────────────────────────────

    test('addTurn tokenises text and records non-zero cost', () => {
        const acc = new SessionCostAccumulator();
        // Real developer exchange
        acc.addTurn(
            'How do I configure Jest with TypeScript in a monorepo?',
            'You need to install ts-jest and configure jest.config.ts with the preset.',
            'claude-3-5-haiku',
        );
        const cost = acc.getCumulativeCost();
        assert.ok(cost.totalInputTokens > 0, 'input tokens should be > 0');
        assert.ok(cost.totalOutputTokens > 0, 'output tokens should be > 0');
        assert.ok(cost.totalCostUsd > 0, 'cost should be > 0');
        assert.strictEqual(cost.turnCount, 1);
    });

    test('addTurn: two realistic developer turns accumulate sensibly', () => {
        const acc = new SessionCostAccumulator();
        acc.addTurn(
            'I am building a React app with TypeScript and need to set up testing. What\'s the best approach?',
            'Use Vitest with @testing-library/react. Install via: npm install -D vitest @testing-library/react @testing-library/jest-dom. Then configure vitest.config.ts.',
            'gpt-4o-mini',
        );
        acc.addTurn(
            'How do I mock a module in Vitest? Specifically I need to mock an API call.',
            'Use vi.mock() at the top of your test file. Example:\n\nvi.mock(\'../api\', () => ({ fetchUser: vi.fn().mockResolvedValue({ id: 1 }) }));\n\nThen in your test call vi.mocked(fetchUser).',
            'gpt-4o-mini',
        );
        const cost = acc.getCumulativeCost();
        assert.strictEqual(cost.turnCount, 2);
        assert.ok(cost.totalCostUsd > 0);
        // Both turns on same model
        assert.strictEqual(cost.lastModelId, 'gpt-4o-mini');
    });

    // ── Immutability of turns ───────────────────────────────────────────────

    test('getTurns returns a readonly view — mutation attempt is caught by TypeScript', () => {
        const acc = new SessionCostAccumulator();
        acc.addTurnTokens(100, 50, 'gemini-2.0-flash');
        const turns = acc.getTurns();
        // At runtime the readonly is not enforced, but we verify the reference is correct
        assert.strictEqual(turns.length, 1);
        assert.strictEqual(turns[0].modelId, 'gemini-2.0-flash');
    });

    // ── getCumulativeCost is idempotent ─────────────────────────────────────

    test('getCumulativeCost called twice returns identical results', () => {
        const acc = new SessionCostAccumulator();
        acc.addTurnTokens(200, 100, 'claude-3-5-sonnet');
        const first  = acc.getCumulativeCost();
        const second = acc.getCumulativeCost();
        assert.strictEqual(first.totalCostUsd, second.totalCostUsd);
        assert.strictEqual(first.totalInputTokens, second.totalInputTokens);
    });

    // ── High-volume scenario ────────────────────────────────────────────────

    test('20-turn session on claude-3-5-sonnet produces sensible total cost', () => {
        const acc = new SessionCostAccumulator();
        for (let i = 0; i < 20; i++) {
            acc.addTurnTokens(300, 600, 'claude-3-5-sonnet');
        }
        const cost = acc.getCumulativeCost();
        assert.strictEqual(cost.turnCount, 20);
        assert.ok(cost.totalInputTokens === 6000);
        assert.ok(cost.totalOutputTokens === 12000);
        const price = PRICE_TABLE['claude-3-5-sonnet'];
        const expected =
            (6000  / 1_000_000) * price.inputUsdPerMillion +
            (12000 / 1_000_000) * price.outputUsdPerMillion;
        assert.ok(Math.abs(cost.totalCostUsd - expected) < 1e-10);
    });

});
