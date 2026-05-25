// src/analytics/promptAnalyzer.ts
// Analyzes a draft prompt for cost, verbosity, and similarity to past queries
// (Feature 20: Prompt Cost Analysis).

import { countTokens, estimateCost, formatCostUsd, CostEstimate } from '../utils/tokenizer';
import { ModelId } from '../utils/modelPriceTable';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VerbosityFlag {
    /** Short code for the issue */
    code: 'LARGE_CODE_BLOCK' | 'OPEN_ENDED' | 'MULTIPLE_QUESTIONS' | 'VERY_LONG' | 'REPETITIVE_PHRASING';
    /** Human-readable description */
    description: string;
}

export interface SimilarSession {
    sessionId: string;
    title: string;
    score: number;
    /** ISO 8601 date of the similar session */
    date?: string;
}

/** Result returned by the LLM analysis provider. */
export interface LlmPromptAnalysis {
    verbosityFlags: VerbosityFlag[];
    modelSuggestion: ModelId;
    rewriteSuggestion?: string;
}

/** Injectable LLM analysis provider — implement to swap the Copilot model. */
export interface ILlmAnalysisProvider {
    analyze(prompt: string, tokenCount: number, token?: unknown): Promise<LlmPromptAnalysis | null>;
}

export interface PromptAnalysis {
    /** Number of estimated input tokens */
    tokenCount: number;
    /** Cost estimate across several models */
    costEstimates: Array<{ model: ModelId; estimate: CostEstimate }>;
    /** Suggested cheapest model that can handle this prompt size */
    suggestedModel: ModelId;
    /** Verbosity / quality flags */
    verbosityFlags: VerbosityFlag[];
    /** Past sessions with semantically similar queries (may be empty if semantic indexer unavailable) */
    similarSessions: SimilarSession[];
    /** Summary sentence */
    summary: string;
    /** LLM-suggested concise rewrite of the prompt, if provided */
    rewriteSuggestion?: string;
    /** Which analysis path ran: 'llm' when the Copilot model was used, 'heuristic' otherwise */
    analysisSource: 'llm' | 'heuristic';
}

// Open-ended phrases that indicate the user hasn't constrained the output
const OPEN_ENDED_RE = /\b(tell me (everything|all|anything)|explain (everything|all|in detail|fully|completely|thoroughly)|write me a (complete|full|comprehensive)|give me (a|an) overview|describe (everything|all|the entire|the whole))\b/i;

const MULTIPLE_Q_RE = /\?/g;

const REPETITIVE_BLOCKS_RE = /(\b\w{5,}\b)(?:.*?\b\1\b){3,}/gs;

// ─── PromptAnalyzer ───────────────────────────────────────────────────────────

/**
 * Interface for the semantic search capability that PromptAnalyzer optionally uses.
 * Accepts a partial interface so it can be mocked in tests without a full SemanticIndexer.
 */
export interface ISearchProvider {
    search(query: string, topK: number, minScore?: number): Promise<Array<{
        id: string;
        title: string;
        score: number;
        date?: string;
    }>>;
}

const DEFAULT_MODELS: ModelId[] = [
    'gpt-4o-mini',
    'claude-3-5-haiku',
    'gemini-2.0-flash',
    'claude-3-5-sonnet',
    'gpt-4o',
];

/** Maximum input tokens for "small" models (mini / haiku / flash) */
const SMALL_MODEL_TOKEN_LIMIT = 100_000;

export class PromptAnalyzer {
    constructor(
        private readonly searchProvider?: ISearchProvider,
        private readonly llmProvider?: ILlmAnalysisProvider,
    ) {}

    /**
     * Analyses a draft prompt text.
     * Primary path: LLM (injected provider). Fallback: local heuristics.
     * @param draftPrompt    The prompt text to analyse
     * @param contextWindow  Optional: additional system/context tokens already consumed
     * @param token          Optional cancellation token forwarded to the LLM provider
     */
    async analyze(draftPrompt: string, contextWindow = 0, token?: unknown): Promise<PromptAnalysis> {
        const tokenCount = countTokens(draftPrompt) + contextWindow;

        // Cost estimates (always computed locally — fast and deterministic)
        const costEstimates = DEFAULT_MODELS.map(model => ({
            model,
            estimate: estimateCost(tokenCount, model),
        }));

        // Similarity — best-effort, fails silently if searcher unavailable
        const similarSessions = await this.findSimilar(draftPrompt);

        // ── Primary: LLM analysis ───────────────────────────────────────────
        let verbosityFlags: VerbosityFlag[];
        let suggestedModel: ModelId;
        let rewriteSuggestion: string | undefined;
        let analysisSource: 'llm' | 'heuristic';

        let llmResult: LlmPromptAnalysis | null = null;
        if (this.llmProvider) {
            try {
                llmResult = await this.llmProvider.analyze(draftPrompt, tokenCount, token);
            } catch {
                llmResult = null;
            }
        }

        if (llmResult) {
            verbosityFlags = llmResult.verbosityFlags;
            suggestedModel = llmResult.modelSuggestion;
            rewriteSuggestion = llmResult.rewriteSuggestion;
            analysisSource = 'llm';
        } else {
            // ── Fallback: heuristics ──────────────────────────────────────────
            verbosityFlags = detectVerbosityFlags(draftPrompt, tokenCount);
            suggestedModel = suggestModel(tokenCount, verbosityFlags);
            analysisSource = 'heuristic';
        }

        // Summary
        const cheapest = costEstimates[0];
        const summaryParts: string[] = [
            `~${tokenCount.toLocaleString()} tokens`,
            `est. cost: ${formatCostUsd(cheapest.estimate.totalUsd)} (${cheapest.estimate.modelDisplayName})`,
        ];
        if (verbosityFlags.length > 0) {
            summaryParts.push(`${verbosityFlags.length} verbosity flag(s)`);
        }
        if (similarSessions.length > 0) {
            summaryParts.push(`${similarSessions.length} similar past session(s)`);
        }
        const summary = summaryParts.join(' • ');

        return {
            tokenCount, costEstimates, suggestedModel, verbosityFlags, similarSessions,
            summary, rewriteSuggestion, analysisSource,
        };
    }

    private async findSimilar(prompt: string): Promise<SimilarSession[]> {
        if (!this.searchProvider) { return []; }
        try {
            const hits = await this.searchProvider.search(prompt, 5, 0.7);
            return hits.map(h => ({
                sessionId: h.id,
                title: h.title,
                score: h.score,
                date: h.date,
            }));
        } catch {
            return [];
        }
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function detectVerbosityFlags(text: string, tokenCount: number): VerbosityFlag[] {
    const flags: VerbosityFlag[] = [];

    // Large code block (>500 chars in a fenced block)
    const codeBlockMatch = text.match(/```[\s\S]{500,}?```/);
    if (codeBlockMatch) {
        flags.push({
            code: 'LARGE_CODE_BLOCK',
            description: 'Prompt contains a large code block (>500 chars). Consider referencing a file path instead.',
        });
    }

    // Open-ended phrasing
    if (OPEN_ENDED_RE.test(text)) {
        flags.push({
            code: 'OPEN_ENDED',
            description: 'Open-ended phrasing detected (e.g. "explain everything"). Try to constrain the scope.',
        });
    }

    // Multiple questions
    const questionCount = (text.match(MULTIPLE_Q_RE) ?? []).length;
    if (questionCount >= 3) {
        flags.push({
            code: 'MULTIPLE_QUESTIONS',
            description: `Prompt contains ${questionCount} questions. Consider splitting into multiple focused prompts.`,
        });
    }

    // Very long prompt
    if (tokenCount > 4000) {
        flags.push({
            code: 'VERY_LONG',
            description: `Prompt is very long (~${tokenCount} tokens). This may exceed context windows and increase cost significantly.`,
        });
    }

    // Repetitive phrasing (approximate — same word 4+ times)
    if (REPETITIVE_BLOCKS_RE.test(text)) {
        flags.push({
            code: 'REPETITIVE_PHRASING',
            description: 'Detected repeated phrases. Consolidate or remove redundant content.',
        });
    }

    return flags;
}

function suggestModel(tokenCount: number, flags: VerbosityFlag[]): ModelId {
    const hasComplexity = flags.some(f => f.code === 'VERY_LONG');

    if (tokenCount <= SMALL_MODEL_TOKEN_LIMIT && !hasComplexity) {
        return 'gemini-2.0-flash'; // cheapest capable model
    }
    if (tokenCount <= 200_000) {
        return 'claude-3-5-haiku';
    }
    return 'claude-3-5-sonnet';
}
