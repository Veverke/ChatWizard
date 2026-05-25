// src/analytics/sessionCostAdvisor.ts
//
// Orchestrates the session cost advice: accumulates per-turn costs, runs the
// prompt consolidator, estimates the hypothetical consolidated cost, and
// returns a CostAdvice when meaningful savings (>= $0.001) are possible.
//
// No VS Code dependency — fully unit-testable via injected consolidation fn.

import { SessionCostAccumulator } from './sessionCostAccumulator';
import type { ConsolidationResult } from './promptConsolidator';
import { ModelId, PRICE_TABLE, resolveModelId } from '../utils/modelPriceTable';

// ── Types ────────────────────────────────────────────────────────────────────

export interface AdviseTurn {
    userText: string;
    assistantText: string;
    /** ModelId or raw model name string (resolved via resolveModelId) */
    modelId: ModelId | string;
}

export interface CostAdvice {
    /** Total USD spent across all turns so far */
    cumulativeCostUsd: number;
    /** The single consolidated prompt the LLM/heuristic produced */
    consolidatedPrompt: string;
    /** Estimated USD for a single consolidated turn */
    consolidatedCostUsd: number;
    /** Absolute savings: cumulativeCostUsd - consolidatedCostUsd */
    savingsUsd: number;
    /** Savings as a percentage of cumulativeCostUsd (0–100) */
    savingsPct: number;
    turnCount: number;
    modelDisplayName: string;
}

/**
 * Function signature for the injected consolidation strategy.
 * Either the LLM variant or the heuristic variant.
 */
export type ConsolidateFn = (messages: string[]) => Promise<ConsolidationResult | null>;

/** Minimum savings (USD) required before advice is shown. */
const MIN_SAVINGS_USD = 0.001;

// ── SessionCostAdvisor ───────────────────────────────────────────────────────

export class SessionCostAdvisor {
    constructor(private readonly consolidate: ConsolidateFn) {}

    /**
     * Computes cost advice for the given turns.
     *
     * Returns null when:
     *   - fewer than 2 turns
     *   - consolidation yields null (all messages are duplicates or single message)
     *   - estimated savings < MIN_SAVINGS_USD ($0.001)
     */
    async advise(turns: AdviseTurn[]): Promise<CostAdvice | null> {
        if (turns.length < 2) { return null; }

        // Resolve model IDs
        const resolvedTurns = turns.map(t => ({
            ...t,
            modelId: resolveModelId(String(t.modelId)) ?? 'gpt-4o-mini' as ModelId,
        }));

        // Accumulate actual session cost
        const accumulator = new SessionCostAccumulator();
        for (const turn of resolvedTurns) {
            accumulator.addTurn(turn.userText, turn.assistantText, turn.modelId);
        }
        const cost = accumulator.getCumulativeCost();
        if (cost.totalCostUsd === 0) { return null; }

        // Consolidate user messages
        const userMessages = resolvedTurns.map(t => t.userText);
        let consolidation: ConsolidationResult | null;
        try {
            consolidation = await this.consolidate(userMessages);
        } catch {
            return null;
        }
        if (!consolidation) { return null; }

        // Estimate consolidated cost:
        //   input  = consolidated prompt tokens
        //   output = average assistant response length (proxy for a single on-target response)
        const avgAssistantTokens =
            Math.ceil(cost.totalOutputTokens / resolvedTurns.length);
        const price = PRICE_TABLE[cost.lastModelId];
        const consolidatedCostUsd =
            (consolidation.consolidatedTokenCount / 1_000_000) * price.inputUsdPerMillion +
            (avgAssistantTokens / 1_000_000) * price.outputUsdPerMillion;

        const savingsUsd = cost.totalCostUsd - consolidatedCostUsd;
        if (savingsUsd < MIN_SAVINGS_USD) { return null; }

        const savingsPct = Math.min(
            100,
            Math.round((savingsUsd / cost.totalCostUsd) * 100),
        );

        return {
            cumulativeCostUsd: cost.totalCostUsd,
            consolidatedPrompt: consolidation.consolidatedPrompt,
            consolidatedCostUsd,
            savingsUsd,
            savingsPct,
            turnCount: resolvedTurns.length,
            modelDisplayName: cost.modelDisplayName,
        };
    }
}
