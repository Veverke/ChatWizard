// test/suite/modelNames.test.ts

import * as assert from 'assert';
import { friendlyModelName } from '../../src/analytics/modelNames';

suite('friendlyModelName', () => {

    // ── Blanks / unknown ─────────────────────────────────────────────────────
    test('undefined returns "Unknown"', () => {
        assert.strictEqual(friendlyModelName(undefined), 'Unknown');
    });

    test('null returns "Unknown"', () => {
        assert.strictEqual(friendlyModelName(null), 'Unknown');
    });

    test('empty string returns "Unknown"', () => {
        assert.strictEqual(friendlyModelName(''), 'Unknown');
    });

    test('whitespace-only returns "Unknown"', () => {
        assert.strictEqual(friendlyModelName('   '), 'Unknown');
    });

    // ── Claude 4 ─────────────────────────────────────────────────────────────
    test('claude-sonnet-4-20250514 → Claude Sonnet 4', () => {
        assert.strictEqual(friendlyModelName('claude-sonnet-4-20250514'), 'Claude Sonnet 4');
    });

    test('claude-opus-4-20250514 → Claude Opus 4', () => {
        assert.strictEqual(friendlyModelName('claude-opus-4-20250514'), 'Claude Opus 4');
    });

    test('claude-haiku-4-5-20251001 → Claude Haiku 4.5', () => {
        assert.strictEqual(friendlyModelName('claude-haiku-4-5-20251001'), 'Claude Haiku 4.5');
    });

    test('claude-sonnet-4-6 (no date) → Claude Sonnet 4.6', () => {
        assert.strictEqual(friendlyModelName('claude-sonnet-4-6'), 'Claude Sonnet 4.6');
    });

    test('claude-opus-4 (no date, no minor) → Claude Opus 4', () => {
        assert.strictEqual(friendlyModelName('claude-opus-4'), 'Claude Opus 4');
    });

    // ── Claude 3 ─────────────────────────────────────────────────────────────
    test('claude-3-opus-20240229 → Claude 3 Opus', () => {
        assert.strictEqual(friendlyModelName('claude-3-opus-20240229'), 'Claude 3 Opus');
    });

    test('claude-3-5-sonnet-20241022 → Claude 3.5 Sonnet', () => {
        assert.strictEqual(friendlyModelName('claude-3-5-sonnet-20241022'), 'Claude 3.5 Sonnet');
    });

    test('claude-3-haiku-20240307 → Claude 3 Haiku', () => {
        assert.strictEqual(friendlyModelName('claude-3-haiku-20240307'), 'Claude 3 Haiku');
    });

    test('claude-3-7-sonnet-20250219 → Claude 3.7 Sonnet', () => {
        assert.strictEqual(friendlyModelName('claude-3-7-sonnet-20250219'), 'Claude 3.7 Sonnet');
    });

    // ── Claude 2 / Instant ───────────────────────────────────────────────────
    test('claude-2 → Claude 2', () => {
        assert.strictEqual(friendlyModelName('claude-2'), 'Claude 2');
    });

    test('claude-2.1 → Claude 2', () => {
        assert.strictEqual(friendlyModelName('claude-2.1'), 'Claude 2');
    });

    test('claude-instant-1.2 → Claude Instant', () => {
        assert.strictEqual(friendlyModelName('claude-instant-1.2'), 'Claude Instant');
    });

    // ── OpenAI GPT ───────────────────────────────────────────────────────────
    test('gpt-4o → GPT-4o', () => {
        assert.strictEqual(friendlyModelName('gpt-4o'), 'GPT-4o');
    });

    test('gpt-4o-2024-11-20 → GPT-4o', () => {
        assert.strictEqual(friendlyModelName('gpt-4o-2024-11-20'), 'GPT-4o');
    });

    test('gpt-4o-mini → GPT-4o mini', () => {
        assert.strictEqual(friendlyModelName('gpt-4o-mini'), 'GPT-4o mini');
    });

    test('gpt-4-turbo → GPT-4 Turbo', () => {
        assert.strictEqual(friendlyModelName('gpt-4-turbo'), 'GPT-4 Turbo');
    });

    test('gpt-4-turbo-preview → GPT-4 Turbo', () => {
        assert.strictEqual(friendlyModelName('gpt-4-turbo-preview'), 'GPT-4 Turbo');
    });

    test('gpt-4 → GPT-4', () => {
        assert.strictEqual(friendlyModelName('gpt-4'), 'GPT-4');
    });

    test('gpt-4-0613 → GPT-4', () => {
        assert.strictEqual(friendlyModelName('gpt-4-0613'), 'GPT-4');
    });

    test('gpt-3.5-turbo → GPT-3.5 Turbo', () => {
        assert.strictEqual(friendlyModelName('gpt-3.5-turbo'), 'GPT-3.5 Turbo');
    });

    // ── OpenAI o-series ──────────────────────────────────────────────────────
    test('o1 → o1', () => {
        assert.strictEqual(friendlyModelName('o1'), 'o1');
    });

    test('o1-mini → o1 mini', () => {
        assert.strictEqual(friendlyModelName('o1-mini'), 'o1 mini');
    });

    test('o1-preview → o1 Preview', () => {
        assert.strictEqual(friendlyModelName('o1-preview'), 'o1 Preview');
    });

    test('o3 → o3', () => {
        assert.strictEqual(friendlyModelName('o3'), 'o3');
    });

    test('o3-mini → o3 mini', () => {
        assert.strictEqual(friendlyModelName('o3-mini'), 'o3 mini');
    });

    test('o4-mini → o4 mini', () => {
        assert.strictEqual(friendlyModelName('o4-mini'), 'o4 mini');
    });

    // ── Google Gemini ────────────────────────────────────────────────────────
    test('gemini-2.0-flash → Gemini 2.0 Flash', () => {
        assert.strictEqual(friendlyModelName('gemini-2.0-flash'), 'Gemini 2.0 Flash');
    });

    test('gemini-1.5-pro → Gemini 1.5 Pro', () => {
        assert.strictEqual(friendlyModelName('gemini-1.5-pro'), 'Gemini 1.5 Pro');
    });

    test('gemini-pro → Gemini Pro', () => {
        assert.strictEqual(friendlyModelName('gemini-pro'), 'Gemini Pro');
    });

    // ── Cursor-native ────────────────────────────────────────────────────────
    test('cursor-fast → Cursor Fast', () => {
        assert.strictEqual(friendlyModelName('cursor-fast'), 'Cursor Fast');
    });

    test('cursor-small → Cursor Small', () => {
        assert.strictEqual(friendlyModelName('cursor-small'), 'Cursor Small');
    });

    test('cursor-fast case-insensitive → Cursor Fast', () => {
        assert.strictEqual(friendlyModelName('CURSOR-FAST'), 'Cursor Fast');
    });

    // Cursor surfaces Claude/GPT/Gemini model IDs — verify they pass through correctly
    test('claude-3-5-sonnet-20241022 (surfaced by Cursor) → Claude 3.5 Sonnet', () => {
        assert.strictEqual(friendlyModelName('claude-3-5-sonnet-20241022'), 'Claude 3.5 Sonnet');
    });

    test('gemini-2.0-flash (surfaced by Cursor) → Gemini 2.0 Flash', () => {
        assert.strictEqual(friendlyModelName('gemini-2.0-flash'), 'Gemini 2.0 Flash');
    });

    // ── Fallback ─────────────────────────────────────────────────────────────
    test('unrecognised model passes through as-is', () => {
        assert.strictEqual(friendlyModelName('some-future-model-x'), 'some-future-model-x');
    });

    test('leading/trailing whitespace is trimmed before fallback', () => {
        assert.strictEqual(friendlyModelName('  gpt-4o  '), 'GPT-4o');
    });
});
