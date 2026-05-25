// src/utils/modelPriceTable.ts
// Price table for LLM token costs (USD per million tokens).
// Update the "Last updated" comment when prices change.
//
// Last updated: 2025-05

/** Model identifier used as key in the price table. */
export type ModelId =
    | 'gpt-4o'
    | 'gpt-4o-mini'
    | 'claude-3-5-sonnet'
    | 'claude-3-5-haiku'
    | 'claude-3-haiku'
    | 'claude-3-7-sonnet'
    | 'gemini-1.5-pro'
    | 'gemini-2.0-flash'
    | 'gemini-1.5-flash';

export interface PriceEntry {
    /** Cost per million input tokens in USD */
    inputUsdPerMillion: number;
    /** Cost per million output tokens in USD */
    outputUsdPerMillion: number;
    /** Human-readable display name */
    displayName: string;
}

/**
 * Price table keyed by ModelId.
 * All values are approximate list prices at time of last update.
 * Note: Prices change frequently — treat estimates as indicative only.
 */
export const PRICE_TABLE: Record<ModelId, PriceEntry> = {
    'gpt-4o': {
        inputUsdPerMillion: 5.00,
        outputUsdPerMillion: 15.00,
        displayName: 'GPT-4o',
    },
    'gpt-4o-mini': {
        inputUsdPerMillion: 0.15,
        outputUsdPerMillion: 0.60,
        displayName: 'GPT-4o mini',
    },
    'claude-3-5-sonnet': {
        inputUsdPerMillion: 3.00,
        outputUsdPerMillion: 15.00,
        displayName: 'Claude 3.5 Sonnet',
    },
    'claude-3-5-haiku': {
        inputUsdPerMillion: 0.80,
        outputUsdPerMillion: 4.00,
        displayName: 'Claude 3.5 Haiku',
    },
    'claude-3-haiku': {
        inputUsdPerMillion: 0.25,
        outputUsdPerMillion: 1.25,
        displayName: 'Claude 3 Haiku',
    },
    'claude-3-7-sonnet': {
        inputUsdPerMillion: 3.00,
        outputUsdPerMillion: 15.00,
        displayName: 'Claude 3.7 Sonnet',
    },
    'gemini-1.5-pro': {
        inputUsdPerMillion: 3.50,
        outputUsdPerMillion: 10.50,
        displayName: 'Gemini 1.5 Pro',
    },
    'gemini-2.0-flash': {
        inputUsdPerMillion: 0.15,
        outputUsdPerMillion: 0.60,
        displayName: 'Gemini 2.0 Flash',
    },
    'gemini-1.5-flash': {
        inputUsdPerMillion: 0.075,
        outputUsdPerMillion: 0.30,
        displayName: 'Gemini 1.5 Flash',
    },
};

/**
 * Maps common model name variants (as found in session data) to a ModelId key.
 * Case-insensitive matching.
 */
const MODEL_ALIASES: Record<string, ModelId> = {
    'gpt-4o':                   'gpt-4o',
    'gpt4o':                    'gpt-4o',
    'gpt-4o-mini':              'gpt-4o-mini',
    'gpt4omini':                'gpt-4o-mini',
    'claude-3-5-sonnet':        'claude-3-5-sonnet',
    'claude-3.5-sonnet':        'claude-3-5-sonnet',
    'claude-sonnet':            'claude-3-5-sonnet',
    'claude-sonnet-4':          'claude-3-7-sonnet',
    'claude-sonnet-4-5':        'claude-3-7-sonnet',
    'claude-3-7-sonnet':        'claude-3-7-sonnet',
    'claude-3.7-sonnet':        'claude-3-7-sonnet',
    'claude-3-haiku':           'claude-3-haiku',
    'claude-3.5-haiku':         'claude-3-5-haiku',
    'claude-3-5-haiku':         'claude-3-5-haiku',
    'gemini-1.5-pro':           'gemini-1.5-pro',
    'gemini-15-pro':            'gemini-1.5-pro',
    'gemini-1.5-flash':         'gemini-1.5-flash',
    'gemini-2.0-flash':         'gemini-2.0-flash',
    'gemini-20-flash':          'gemini-2.0-flash',
};

/** Resolves a raw model name to a known ModelId, or returns undefined. */
export function resolveModelId(rawName: string): ModelId | undefined {
    const key = rawName.toLowerCase().trim();
    // Exact match
    if (key in MODEL_ALIASES) { return MODEL_ALIASES[key]; }
    // Prefix match
    for (const [alias, id] of Object.entries(MODEL_ALIASES)) {
        if (key.startsWith(alias) || alias.startsWith(key)) { return id; }
    }
    return undefined;
}
