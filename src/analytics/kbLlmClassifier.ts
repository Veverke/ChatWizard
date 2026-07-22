// src/analytics/kbLlmClassifier.ts
// Feature 23 — LLM-based KB entry classification.
// Uses the VS Code Copilot Language Model API to classify sessions into
// user-configured categories. Falls back gracefully when the LM API is unavailable.

import * as vscode from 'vscode';
import type { Session } from '../types/index';

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

export function buildClassificationPrompt(session: Session): string {
    const firstMessages = session.messages.slice(0, 5);
    const conversation = firstMessages
        .map(m => `[${m.role.toUpperCase()}]\n${m.content.slice(0, 1500)}`)
        .join('\n\n');

    return [
        `Session title: ${session.title}`,
        '',
        conversation,
    ].join('\n');
}

export function buildSystemPrompt(categories: string[]): string {
    return [
        'You are a knowledge base classifier. Your task is to classify a coding session',
        'into exactly one of the following categories:',
        '',
        ...categories.map((c, i) => `${i + 1}. ${c}`),
        '',
        'Read the conversation carefully and choose the category that best reflects',
        'the primary intent or topic of the session.',
        '',
        'Rules:',
        '- Return ONLY the category name — no markdown, no explanation, no punctuation.',
        '- Choose the SINGLE best-matching category.',
        '- If multiple categories could apply, pick the one that best describes the',
        '  core purpose of the conversation.',
        '- Match the category name exactly as listed above (case-insensitive).',
    ].join('\n');
}

// ── Response parsing ────────────────────────────────────────────────────────

export function parseClassification(raw: string, categories: string[]): string | null {
    const cleaned = raw.trim().toLowerCase();

    // Exact match (case-insensitive)
    for (const cat of categories) {
        if (cleaned === cat.toLowerCase()) { return cat; }
    }

    // Contains match
    for (const cat of categories) {
        if (cleaned.includes(cat.toLowerCase())) { return cat; }
    }

    return null;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Classify a session into one of the given categories using the VS Code LM API.
 *
 * Returns the category name on success, or `null` if the LM API is unavailable
 * or the response could not be parsed.
 */
export async function classifySessionWithLlm(
    session: Session,
    categories: string[],
): Promise<string | null> {
    try {
        const model = await selectCopilotModel();
        if (!model) { return null; }

        const content = buildClassificationPrompt(session);
        const messages = [vscode.LanguageModelChatMessage.User(content)];
        const response = await model.sendRequest(messages, {
            systemPrompt: buildSystemPrompt(categories),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);

        let raw = '';
        for await (const chunk of response.text) {
            raw += chunk;
        }

        return parseClassification(raw, categories);
    } catch {
        return null;
    }
}