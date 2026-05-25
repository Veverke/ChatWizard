// src/analytics/copilotPromptAnalysisProvider.ts
//
// Implements ILlmAnalysisProvider using the VS Code Copilot Language Model API
// (zero premium requests when using o4-mini / gpt-4o-mini via the copilot vendor).
//
// Ask the LLM to return a strict JSON object. If the response cannot be parsed
// as valid JSON, return null so the caller can fall back to heuristics.

import type { ILlmAnalysisProvider, LlmPromptAnalysis, VerbosityFlag } from './promptAnalyzer';
import type { ModelId } from '../utils/modelPriceTable';
import { resolveModelId } from '../utils/modelPriceTable';

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

// ── Model selection helpers ──────────────────────────────────────────────────

const FREE_MODEL_CHAIN = [
    { family: 'o4-mini' },
    { family: 'gpt-4o-mini' },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function selectCopilotModel(vscode: any): Promise<any | undefined> {
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

// ── JSON parsing with fallback ───────────────────────────────────────────────

function extractJson(raw: string): string {
    // Strip potential markdown fences
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) { return fence[1].trim(); }
    // Try to find a JSON object directly
    const brace = raw.match(/\{[\s\S]*\}/);
    if (brace) { return brace[0]; }
    return raw.trim();
}

function parseResponse(raw: string): LlmPromptAnalysis | null {
    try {
        const jsonStr = extractJson(raw);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parsed = JSON.parse(jsonStr) as any;

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
    async analyze(prompt: string, tokenCount: number, token?: unknown): Promise<LlmPromptAnalysis | null> {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const vscode = require('vscode') as typeof import('vscode');
            const model = await selectCopilotModel(vscode);
            if (!model) { return null; }

            const userContent =
                `Token count: ~${tokenCount}\n\nPrompt to analyze:\n${prompt.slice(0, 6000)}`;

            const messages = [
                vscode.LanguageModelChatMessage.User(userContent),
            ];

            const ct = token as import('vscode').CancellationToken | undefined
                ?? new vscode.CancellationTokenSource().token;

            const response = await model.sendRequest(
                messages,
                { systemPrompt: SYSTEM_PROMPT },
                ct,
            );

            let raw = '';
            for await (const chunk of response.text) { raw += chunk; }
            return parseResponse(raw);
        } catch {
            return null;
        }
    }
}
