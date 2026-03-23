// src/analytics/modelNames.ts

/**
 * Maps a raw API model ID to a human-friendly display name.
 *
 * Handles:
 *   - Anthropic Claude 4.x / 3.x / 2.x / Instant
 *   - OpenAI GPT-4o, GPT-4, GPT-3.5, o1/o3/o4 reasoning series
 *   - Google Gemini families
 *
 * Falls back to the raw string (trimmed) for unrecognised IDs.
 * Returns "Unknown" for blank/whitespace input.
 */
export function friendlyModelName(raw: string | undefined | null): string {
    if (!raw) { return 'Unknown'; }
    const s = raw.trim();
    if (!s || s === '<synthetic>') { return 'Unknown'; }

    // ── Anthropic Claude ──────────────────────────────────────────────────────

    // Claude 4.x new naming: claude-{variant}-4[-minor][-YYYYMMDD]
    // Minor version is 1-2 digits; date suffix is exactly 8 digits — keep them distinct.
    // e.g. claude-sonnet-4-20250514, claude-haiku-4-5-20251001, claude-opus-4-5
    const c4 = s.match(/^claude-(opus|sonnet|haiku)-4(-(\d{1,2}))?(?:-\d{8})?$/i);
    if (c4) {
        const variant = cap(c4[1]);
        const minor = c4[3];
        return minor ? `Claude ${variant} 4.${minor}` : `Claude ${variant} 4`;
    }

    // Claude 3.x: claude-3[-minor]-{variant}[-YYYYMMDD]
    // e.g. claude-3-opus-20240229, claude-3-5-sonnet-20241022, claude-3-7-sonnet-20250219
    const c3 = s.match(/^claude-3(-(\d+))?-(opus|sonnet|haiku)(?:-\d{8})?$/i);
    if (c3) {
        const minor = c3[2];
        const variant = cap(c3[3]);
        return minor ? `Claude 3.${minor} ${variant}` : `Claude 3 ${variant}`;
    }

    // Claude 2: claude-2[.1][-YYYYMMDD]
    if (/^claude-2(\.\d+)?(?:-\d+)?$/i.test(s)) { return 'Claude 2'; }

    // Claude Instant
    if (/^claude-instant/i.test(s)) { return 'Claude Instant'; }

    // ── OpenAI GPT / reasoning series ─────────────────────────────────────────

    // GPT-4o mini must come before GPT-4o (more specific first)
    if (/^gpt-4o-mini$/i.test(s)) { return 'GPT-4o mini'; }
    // GPT-4o (any suffix like -2024-11-20)
    if (/^gpt-4o/i.test(s)) { return 'GPT-4o'; }

    // GPT-4 Turbo
    if (/^gpt-4-turbo/i.test(s)) { return 'GPT-4 Turbo'; }

    // GPT-4 (plain or date-versioned: gpt-4-0613 etc.)
    if (/^gpt-4(?:-\d+)?$/i.test(s)) { return 'GPT-4'; }

    // GPT-3.5 Turbo
    if (/^gpt-3\.5-turbo/i.test(s)) { return 'GPT-3.5 Turbo'; }

    // o-series reasoning models
    if (/^o1-preview$/i.test(s)) { return 'o1 Preview'; }
    if (/^o1-mini$/i.test(s))    { return 'o1 mini'; }
    if (/^o1$/i.test(s))         { return 'o1'; }
    if (/^o3-mini$/i.test(s))    { return 'o3 mini'; }
    if (/^o3$/i.test(s))         { return 'o3'; }
    if (/^o4-mini$/i.test(s))    { return 'o4 mini'; }

    // ── Cursor-native models ───────────────────────────────────────────────────

    if (/^cursor-fast$/i.test(s))  { return 'Cursor Fast'; }
    if (/^cursor-small$/i.test(s)) { return 'Cursor Small'; }

    // ── Google Gemini ──────────────────────────────────────────────────────────

    // Versioned: gemini-{major.minor}-{variant} e.g. gemini-2.0-flash, gemini-1.5-pro
    const gemVer = s.match(/^gemini-(\d+\.\d+)-(\w+)$/i);
    if (gemVer) { return `Gemini ${gemVer[1]} ${cap(gemVer[2])}`; }

    // Unversioned: gemini-pro, gemini-ultra, gemini-flash
    const gemPlain = s.match(/^gemini-(pro|ultra|flash)$/i);
    if (gemPlain) { return `Gemini ${cap(gemPlain[1])}`; }

    // ── Fallback ───────────────────────────────────────────────────────────────
    return s;
}

function cap(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
