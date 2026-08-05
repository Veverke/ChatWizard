// src/analytics/actionItemVerifier.ts
// Feature 34 — LLM-based verification pass for extracted action items.
// Uses the VS Code Copilot LM API to assess whether each extracted action item
// is genuinely actionable, and marks it with verified=true/false.

import * as vscode from 'vscode';
import type { ActionItem } from '../types/index';

// ── Model selection ──────────────────────────────────────────────────────────

const FREE_MODEL_CHAIN = [
    { family: 'o4-mini' },
    { family: 'gpt-4o-mini' },
];

async function selectCopilotModel(): Promise<vscode.LanguageModelChat | undefined> {
    for (const filter of FREE_MODEL_CHAIN) {
        try {
            const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot', ...filter });
            if (model) { return model; }
        } catch {
            // try next
        }
    }
    return undefined;
}

// ── Prompt building ─────────────────────────────────────────────────────────

function buildVerifySystemPrompt(): string {
    return [
        'You are an action-item verifier for developer coding sessions.',
        'Given a list of action items extracted from a coding conversation,',
        'assess whether each one is a real, concrete action item.',
        '',
        'Rules:',
        '- If the item is vague, generic, or not actually actionable, mark it as invalid.',
        '- If the item is a concrete, specific task the developer should do, mark it as valid.',
        '- Reply with one line per item, prefixing each line with either "[VALID]" or "[INVALID]".',
        '- Match the exact order of the input items.',
        '',
        'Examples:',
        'Input:',
        '- You should fix the bug',
        '- Next step is to refactor the API handler',
        '- I think you should look at the code',
        'Output:',
        '[VALID] fix the bug',
        '[VALID] refactor the API handler',
        '[INVALID] I think you should look at the code',
    ].join('\n');
}

function buildVerifyUserPrompt(sessionTitle: string, items: ActionItem[]): string {
    const lines = items.map((item, i) => `[${i}] ${item.text}`).join('\n');
    return [
        `Session title: ${sessionTitle}`,
        '',
        'Action items to verify:',
        lines,
    ].join('\n');
}

// ── Response parsing ────────────────────────────────────────────────────────

interface VerificationResult {
    /** Indices of items the LLM confirmed as valid */
    validIndices: Set<number>;
}

function parseVerificationResponse(raw: string, itemCount: number): VerificationResult {
    const validIndices = new Set<number>();
    const lines = raw.trim().split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        // Match "[VALID] ..." or "[INVALID] ..."
        const match = trimmed.match(/^\[(VALID|INVALID)\]\s*(.*)/i);
        if (!match) { continue; }
        if (match[1].toUpperCase() !== 'VALID') { continue; }

        // Find the item index by matching the description text
        const desc = match[2].trim().toLowerCase();
        // Walk through items in order to find the closest match
        for (let i = 0; i < itemCount; i++) {
            // Accept if the description is a substring of the original item text (or vice versa)
            // or if this line corresponds to the nth VALID in sequence
            if (validIndices.has(i)) { continue; }
            break;
        }
        // Simple positional approach: nth VALID line corresponds to nth item
    }

    // Fallback: use positional matching — the LLM returns [VALID] or [INVALID]
    // for each item in order, one per line.
    let validIdx = 0;
    for (const line of lines) {
        const trimmed = line.trim();
        if (/^\[VALID\]/i.test(trimmed)) {
            if (validIdx < itemCount) {
                validIndices.add(validIdx);
            }
            validIdx++;
        } else if (/^\[INVALID\]/i.test(trimmed)) {
            validIdx++;
        }
    }

    return { validIndices };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Verifies a batch of action items using the Copilot LM API.
 * Marks each item as `verified: true` if the LLM confirms it is genuinely
 * actionable, or `verified: false` if it's vague/generic.
 *
 * Returns the updated items array. If the LM API is unavailable, returns
 * items unchanged (no verification).
 *
 * @param sessionTitle  Session title for context
 * @param items         Action items to verify
 * @param token         Optional cancellation token
 */
export async function verifyActionItemsWithLlm(
    sessionTitle: string,
    items: ActionItem[],
    token?: vscode.CancellationToken,
): Promise<ActionItem[]> {
    if (items.length === 0) { return items; }

    try {
        const model = await selectCopilotModel();
        if (!model) { return items; }

        const userContent = buildVerifyUserPrompt(sessionTitle, items);
        const messages = [vscode.LanguageModelChatMessage.User(userContent)];
        const response = await model.sendRequest(messages, {
            systemPrompt: buildVerifySystemPrompt(),
        } as any);

        let raw = '';
        for await (const chunk of response.text) {
            raw += chunk;
            if (token?.isCancellationRequested) { return items; }
        }

        const { validIndices } = parseVerificationResponse(raw, items.length);
        return items.map((item, i) => ({
            ...item,
            verified: validIndices.has(i),
        }));
    } catch {
        // LM API unavailable or error — return items unchanged
        return items;
    }
}