// src/analytics/actionItemVerifier.ts
// Feature 34 — LLM-based verification pass for extracted action items.
// Uses the central llmClient (VS Code LM API → Cursor CLI) to assess whether
// each extracted action item is genuinely actionable.

import type { ActionItem } from '../types/index';
import { promptLlm } from './llmClient';

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
 * Verifies a batch of action items using the central llmClient.
 * Marks each item as `verified: true` if the LLM confirms it is genuinely
 * actionable, or `verified: false` if it's vague/generic.
 *
 * Returns the updated items array. If no LLM provider is available, returns
 * items unchanged (no verification).
 */
export async function verifyActionItemsWithLlm(
    sessionTitle: string,
    items: ActionItem[],
): Promise<ActionItem[]> {
    if (items.length === 0) { return items; }

    try {
        const systemPrompt = buildVerifySystemPrompt();
        const userContent = buildVerifyUserPrompt(sessionTitle, items);

        const raw = await promptLlm(systemPrompt, userContent, { timeoutMs: 30_000 });
        if (raw === null) { return items; }

        const { validIndices } = parseVerificationResponse(raw, items.length);
        return items.map((item, i) => ({
            ...item,
            verified: validIndices.has(i),
        }));
    } catch {
        // LLM provider unavailable or error — return items unchanged
        return items;
    }
}