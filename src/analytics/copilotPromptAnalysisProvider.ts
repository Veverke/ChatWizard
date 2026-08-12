// src/analytics/copilotPromptAnalysisProvider.ts
//
// Implements ILlmAnalysisProvider using the central llmClient.
// Falls back gracefully when no provider is available.

import type { ILlmAnalysisProvider, LlmPromptAnalysis, VerbosityFlag } from './promptAnalyzer';
import type { ModelId } from '../utils/modelPriceTable';
import { resolveModelId } from '../utils/modelPriceTable';
import { promptLlm } from './llmClient';

// ── Valid codes the LLM is allowed to emit ───────────────────────────────────
const VALID_CODES = new Set<string>([
    'LARGE_CODE_BLOCK', 'OPEN_ENDED', 'MULTIPLE_QUESTIONS', 'VERY_LONG', 'REPETITIVE_PHRASING',
]);

const SYSTEM_PROMPT = `You are a concise prompt quality analyzer for AI coding assistants.
Given a user's draft prompt and its estimated token count, analyze it for quality issues.

Return ONLY valid JSON — no markdown fences, no commentary — in exactly this shape:
{
  "verbosityFlags": [
    { "code": "FLAG_CODE", "description": "One actionable tip for the user (max 20 words)" }
  ],
  "modelSuggestion": "cheapest-model-id",
  "rewriteSuggestion": "optional concise rewrite if savings >25%"
}

Allowed flag codes (only include codes that genuinely apply):
- LARGE_CODE_BLOCK : prompt pastes raw code that should be referenced by file path instead
- OPEN_ENDED       : uses vague scope ("explain everything", "tell me all about", "describe everything")
- MULTIPLE_QUESTIONS: contains 3+ distinct questions better sent as separate prompts
- VERY_LONG        : over 4000 tokens
- REPETITIVE_PHRASING: repeats the same idea or phrase multiple times

Allowed modelSuggestion values:
  gpt-4o-mini, claude-3-5-haiku, gemini-2.0-flash, claude-3-5-sonnet, gpt-4o

Rules:
- Choose the cheapest model that fits the token count and complexity.
- Include rewriteSuggestion only when the prompt can be meaningfully shortened (>25% fewer tokens).
- If no flags apply, return "verbosityFlags": [].
- Never add extra keys outside the schema.`;

// ── JSON parsing with fallback ───────────────────────────────────────────────

export function extractJson(raw: string): string {
    // Strip potential markdown fences
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) { return fence[1].trim(); }
    // Try to find a JSON object directly
    const brace = raw.match(/\{[\s\S]*\}/);
    if (brace) { return brace[0]; }
    return raw.trim();
}

export function parseResponse(raw: string): LlmPromptAnalysis | null {
    try {
        const jsonStr = extractJson(raw);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parsed = JSON.parse(jsonStr) as any;

        // Reject non-object JSON (arrays, primitives, null)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null;
        }

        // Validate verbosityFlags
        const rawFlags: unknown[] = Array.isArray(parsed.verbosityFlags) ? parsed.verbosityFlags : [];
        const verbosityFlags: VerbosityFlag[] = rawFlags
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .filter((f: any) => f && typeof f.code === 'string' && VALID_CODES.has(f.code))
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((f: any) => ({
                code: f.code as VerbosityFlag['code'],
                description: typeof f.description === 'string' ? f.description.slice(0, 200) : f.code,
            }));

        // Validate modelSuggestion
        const rawModel = typeof parsed.modelSuggestion === 'string' ? parsed.modelSuggestion : '';
        const modelSuggestion: ModelId = resolveModelId(rawModel) ?? 'gpt-4o-mini';

        // rewriteSuggestion is optional
        const rewriteSuggestion =
            typeof parsed.rewriteSuggestion === 'string' && parsed.rewriteSuggestion.trim()
                ? parsed.rewriteSuggestion.trim()
                : undefined;

        return { verbosityFlags, modelSuggestion, rewriteSuggestion };
    } catch {
        return null;
    }
}

// ── Provider implementation ──────────────────────────────────────────────────

export class CopilotPromptAnalysisProvider implements ILlmAnalysisProvider {
    async analyze(prompt: string, tokenCount: number, _token?: unknown): Promise<LlmPromptAnalysis | null> {
        try {
            const userContent =
                `Token count: ~${tokenCount}\n\nPrompt to analyze:\n${prompt.slice(0, 6000)}`;

            const raw = await promptLlm(SYSTEM_PROMPT, userContent, { timeoutMs: 15_000 });
            if (raw === null) { return null; }

            return parseResponse(raw);
        } catch {
            return null;
        }
    }
}
