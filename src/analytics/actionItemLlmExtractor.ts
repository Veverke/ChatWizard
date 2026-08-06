// src/analytics/actionItemLlmExtractor.ts
// Feature 34 — LLM-based action item extraction.
// Uses the VS Code Copilot Language Model API to extract actionable follow-ups
// from sessions. Falls back gracefully when the LM API is unavailable.

import * as vscode from 'vscode';
import type { Session, ActionItem } from '../types/index';

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

export function buildActionItemPrompt(session: Session): string {
    const conversation = session.messages
        .map(m => `[${m.role.toUpperCase()}]\n${m.content.slice(0, 2000)}`)
        .join('\n\n');

    return [
        `Session title: ${session.title}`,
        '',
        conversation,
    ].join('\n');
}

export function buildActionItemSystemPrompt(): string {
    return [
        'You are an action-item extractor for developer coding sessions.',
        'Extract concrete, actionable follow-up tasks from the conversation.',
        '',
        'Guidelines:',
        '- Focus on explicit action items: tasks the developer should do next.',
        '- Include specific bug fixes, refactors, tests, or improvements mentioned.',
        '- One item per line — each line is exactly one action item.',
        '- Keep each item concise (under 200 characters).',
        '- Prefix each item with "- " (dash space).',
        '- If there are NO action items, return exactly: (none)',
        '',
        'Example output:',
        '- Add error handling to the login function',
        '- Run the test suite to verify changes',
        '- Update the API documentation for the new endpoint',
    ].join('\n');
}

/**
 * Parse the LLM response into an array of action item texts.
 * Returns null if the response indicates no action items.
 */
export function parseActionItems(raw: string): string[] | null {
    const trimmed = raw.trim();

    // No action items case
    if (trimmed.toLowerCase() === '(none)') { return null; }

    const lines = trimmed.split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('- '))
        .map(l => l.slice(2).trim())
        .filter(l => l.length > 5);

    return lines.length > 0 ? lines : null;
}

/**
 * Generate a stable, deterministic ID for an action item.
 */
function makeActionItemId(sessionId: string, text: string, index: number): string {
    const prefix = sessionId.slice(0, 8);
    const slug = text.toLowerCase().replace(/\W+/g, '-').slice(0, 20);
    return `${prefix}-${index}-${slug}`;
}

/**
 * Extract action items using the free Copilot LM API.
 *
 * Returns an array of ActionItem objects on success, or `null` if the LM API
 * is unavailable or the response could not be parsed.
 */
export async function extractActionItemsWithLlm(
    session: Session,
): Promise<ActionItem[] | null> {
    try {
        const model = await selectCopilotModel();
        if (!model) { return null; }

        const content = buildActionItemPrompt(session);
        const messages = [vscode.LanguageModelChatMessage.User(content)];
        const response = await model.sendRequest(messages, {
            systemPrompt: buildActionItemSystemPrompt(),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);

        let raw = '';
        for await (const chunk of response.text) {
            raw += chunk;
        }

        const items = parseActionItems(raw);
        if (!items) { return null; }

        const now = new Date().toISOString();
        return items.map((text, i) => ({
            id: makeActionItemId(session.id, text, i),
            text,
            done: false,
            createdAt: now,
            source: 'extracted' as const,
        }));
    } catch {
        return null;
    }
}