// src/views/webviewUtils.ts
//
// Shared utilities for VS Code webview panels.

import * as crypto from 'crypto';

/**
 * Generate a cryptographically random nonce for use in Content-Security-Policy
 * `script-src 'nonce-...'` and `style-src 'nonce-...'` directives.
 *
 * A new nonce must be generated each time a webview's HTML is set so that the
 * CSP nonce is not predictable by content inside the webview.
 */
export function generateNonce(): string {
    return crypto.randomBytes(16).toString('base64');
}

/**
 * SEC-4: Validate a user-supplied color string for safe embedding in CSS.
 * Accepts: 3-digit hex (#abc), 6-digit hex (#aabbcc), rgb(...), rgba(...).
 * Anything else returns the provided `fallback` (e.g. '#007acc').
 *
 * This prevents CSS injection attacks where a settings value like
 *   "red; } body { background: url('https://attacker.com')"
 * could break out of a CSS property declaration.
 */
export function validateColor(value: string, fallback: string): string {
    const trimmed = value.trim();
    if (
        /^#[0-9a-fA-F]{3}$/.test(trimmed) ||
        /^#[0-9a-fA-F]{6}$/.test(trimmed) ||
        /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/.test(trimmed) ||
        /^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*[\d.]+\s*\)$/.test(trimmed)
    ) {
        return trimmed;
    }
    return fallback;
}
