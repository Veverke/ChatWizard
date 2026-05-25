// src/analytics/sessionCostAccumulator.ts
//
// Accumulates per-turn token counts and computes a running USD cost estimate
// for a chat session. Each turn may use a different model (cost is summed
// per-turn using the correct price table entry for that turn).
//
// No VS Code dependency — fully unit-testable.

import { countTokens } from '../utils/tokenizer';
import { ModelId, PRICE_TABLE } from '../utils/modelPriceTable';

// ── Types ────────────────────────────────────────────────────────────────────

export interface TurnRecord {
    userTokens: number;
    assistantTokens: number;
    modelId: ModelId;
}

export interface CumulativeCost {
    totalInputTokens: number;
    totalOutputTokens: number;
    /** Total cost summed across all turns using per-turn model rates */
    totalCostUsd: number;
    turnCount: number;
    /** Display name of the model used in the most recent turn */
    modelDisplayName: string;
    /** ModelId of the most recent turn — used to look up rates for projections */
    lastModelId: ModelId;
}

// ── SessionCostAccumulator ───────────────────────────────────────────────────

export class SessionCostAccumulator {
    private readonly _turns: TurnRecord[] = [];

    /**
     * Tokenizes both sides of a turn and records the result.
     * Use addTurnTokens() when the token counts are already known.
     */
    addTurn(userText: string, assistantText: string, modelId: ModelId): void {
        this.addTurnTokens(
            countTokens(userText),
            countTokens(assistantText),
            modelId,
        );
    }

    /** Records pre-counted token values directly (avoids re-tokenization). */
    addTurnTokens(userTokens: number, assistantTokens: number, modelId: ModelId): void {
        this._turns.push({ userTokens, assistantTokens, modelId });
    }

    getTurns(): readonly TurnRecord[] {
        return this._turns;
    }

    /** Recomputes cumulative cost from scratch on every call. O(n) but n is always small. */
    getCumulativeCost(): CumulativeCost {
        if (this._turns.length === 0) {
            return {
                totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0,
                turnCount: 0, modelDisplayName: '', lastModelId: 'claude-3-5-sonnet',
            };
        }

        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalCostUsd = 0;

        for (const turn of this._turns) {
            totalInputTokens += turn.userTokens;
            totalOutputTokens += turn.assistantTokens;
            const price = PRICE_TABLE[turn.modelId];
            totalCostUsd += (turn.userTokens / 1_000_000) * price.inputUsdPerMillion;
            totalCostUsd += (turn.assistantTokens / 1_000_000) * price.outputUsdPerMillion;
        }

        const lastTurn = this._turns[this._turns.length - 1];
        return {
            totalInputTokens,
            totalOutputTokens,
            totalCostUsd,
            turnCount: this._turns.length,
            modelDisplayName: PRICE_TABLE[lastTurn.modelId].displayName,
            lastModelId: lastTurn.modelId,
        };
    }
}
