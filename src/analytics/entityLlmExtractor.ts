// src/analytics/entityLlmExtractor.ts
// Feature 19 — LLM-based entity extraction.
// Uses the central llmClient (VS Code LM API → Cursor CLI) to extract richer
// semantic entities (frameworks, libraries, API endpoints, protocols, architectural
// concepts) that regex cannot capture.
//
// Falls back gracefully when no LLM provider is available — the caller
// (entityExtractor.ts) then uses the original regex-only extractor.

import type { Session, ExtractedEntities } from '../types/index';
import { promptLlm } from './llmClient';

// ── Prompt building ─────────────────────────────────────────────────────────

export function buildEntitySystemPrompt(): string {
    return [
        'You are an entity extractor for developer coding sessions.',
        'Extract structured entities from the conversation.',
        '',
        'Return a JSON object with these arrays (each up to 15 items, omit empty arrays):',
        '',
        '  "frameworks":    Framework and library names (e.g. "React", "Express", "pandas", "PyTorch", "Jest")',
        '  "apis":          API endpoints, protocols, or service names (e.g. "REST /api/users", "GraphQL", "WebSocket")',
        '  "concepts":      Architectural concepts, patterns, or technical topics (e.g. "dependency injection", "OAuth 2.0", "event sourcing")',
        '  "tools":         CLI tools, build systems, or platforms (e.g. "Webpack", "Docker", "Kubernetes", "AWS")',
        '  "languages":     Programming languages mentioned (e.g. "TypeScript", "Python", "Rust")',
        '',
        'Guidelines:',
        '- Only include entities explicitly mentioned or directly implied in the conversation.',
        '- Do NOT invent entities. Return empty arrays if none are found.',
        '- Be specific: prefer "React Router v6" over just "React".',
        '- Output valid JSON only — no markdown, no explanation.',
        '',
        'Example:',
        '{"frameworks":["React","Express","Prisma"],"apis":["REST /api/workspaces","GraphQL"],"concepts":["dependency injection","middleware pipeline"],"tools":["Webpack","Docker"],"languages":["TypeScript"]}',
    ].join('\n');
}

export function buildEntityUserPrompt(session: Session): string {
    const conversation = session.messages
        .map(m => `[${m.role.toUpperCase()}]\n${m.content.slice(0, 1500)}`)
        .join('\n\n');

    return [
        `Session title: ${session.title}`,
        '',
        conversation,
    ].join('\n');
}

// ── Response parsing ────────────────────────────────────────────────────────

interface LlmEntityResult {
    frameworks?: string[];
    apis?: string[];
    concepts?: string[];
    tools?: string[];
    languages?: string[];
}

/** @internal exported for unit testing */
export function parseEntityResponse(raw: string): LlmEntityResult | null {
    const trimmed = raw.trim();
    // Strip markdown code fences if present
    const jsonStr = trimmed.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    try {
        const parsed = JSON.parse(jsonStr);
        if (typeof parsed !== 'object' || parsed === null) { return null; }
        const result: LlmEntityResult = {};
        for (const key of ['frameworks', 'apis', 'concepts', 'tools', 'languages'] as const) {
            if (Array.isArray(parsed[key])) {
                result[key] = parsed[key]
                    .filter((item: unknown): item is string => typeof item === 'string' && item.length > 0)
                    .slice(0, 15);
            }
        }
        return result;
    } catch {
        return null;
    }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Extracts semantic entities using the central llmClient.
 *
 * Returns an `ExtractedEntities` object with the LLM's output merged into the
 * `semantic` field, or `null` if no LLM provider is available or the response
 * could not be parsed.
 */
export async function extractEntitiesWithLlm(
    session: Session,
): Promise<Partial<ExtractedEntities> | null> {
    try {
        const systemPrompt = buildEntitySystemPrompt();
        const userContent = buildEntityUserPrompt(session);

        const raw = await promptLlm(systemPrompt, userContent, { timeoutMs: 30_000 });
        if (raw === null) { return null; }

        const parsed = parseEntityResponse(raw);
        if (!parsed) { return null; }

        // Return the LLM-extracted entities. The caller (extractEntities) will
        // merge them with the regex-extracted results.
        const semantic: string[] = [];
        for (const key of ['frameworks', 'apis', 'concepts', 'tools', 'languages'] as const) {
            if (parsed[key]) {
                for (const item of parsed[key]) {
                    semantic.push(`[${key.slice(0, -1)}] ${item}`);
                }
            }
        }

        return { semantic };
    } catch {
        return null;
    }
}