// src/analytics/promptConsolidatorLlm.ts
//
// LLM-enhanced prompt consolidator.
//
// Calls the VS Code Copilot Language Model API (o4-mini → gpt-4o-mini,
// zero premium requests) to synthesise a genuinely tight single prompt from
// all user messages in a session.
//
// Falls back to the heuristic consolidate() when:
//   - no Copilot model is available
//   - the LLM request fails for any reason
//   - the response is empty

import type { ConsolidationResult } from './promptConsolidator';
import { consolidate } from './promptConsolidator';
import { countTokens } from '../utils/tokenizer';

const SYSTEM_PROMPT =
    'You are a prompt optimizer for AI coding assistants. ' +
    'The user sent the following numbered messages across a multi-turn chat session. ' +
    'Write a single, minimal, focused prompt that achieves exactly the same goals using the fewest tokens. ' +
    'Preserve ALL intents. Remove conversational filler, politeness phrases, and redundant context. ' +
    'Return ONLY the optimized prompt text — no commentary, no explanation, no numbering.';

const FREE_MODEL_CHAIN = [
    { family: 'o4-mini' },
    { family: 'gpt-4o-mini' },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function selectModel(vscode: any): Promise<any | undefined> {
    for (const filter of FREE_MODEL_CHAIN) {
        try {
            const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot', ...filter });
            if (model) { return model; }
        } catch { /* try next */ }
    }
    return undefined;
}

/**
 * Consolidates multiple user messages into a single optimised prompt using an LLM.
 *
 * Falls back to {@link consolidate} on any error or when no model is available.
 * Returns null only when the heuristic fallback also returns null (< 2 messages
 * or all near-duplicates).
 *
 * @param userMessages  The ordered list of user turns in the session.
 * @param token         Optional VS Code cancellation token.
 */
export async function consolidateLlm(
    userMessages: string[],
    token?: unknown,
): Promise<ConsolidationResult | null> {
    if (userMessages.length < 2) { return null; }

    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const vscode = require('vscode') as typeof import('vscode');
        const model = await selectModel(vscode);
        if (!model) { return consolidate(userMessages); }

        const numbered = userMessages
            .map((m, i) => `Message ${i + 1}:\n${m.slice(0, 1500)}`)
            .join('\n\n---\n\n');

        const ct = (token as import('vscode').CancellationToken | undefined)
            ?? new vscode.CancellationTokenSource().token;

        const response = await model.sendRequest(
            [vscode.LanguageModelChatMessage.User(numbered)],
            { systemPrompt: SYSTEM_PROMPT },
            ct,
        );

        let result = '';
        for await (const chunk of response.text) { result += chunk; }
        result = result.trim();

        if (!result) { return consolidate(userMessages); }

        return {
            consolidatedPrompt: result,
            consolidatedTokenCount: countTokens(result),
            intentCount: userMessages.length,
        };
    } catch {
        return consolidate(userMessages);
    }
}
