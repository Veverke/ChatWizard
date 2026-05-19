// test/e2e/sourceUi.test.ts
// Tests for src/ui/sourceUi.ts pure functions

import * as assert from 'assert';
import {
    friendlySourceName,
    sourceCodiconId,
    sourceBadgeClass,
    SOURCE_BADGE_CLASS,
} from '../../src/ui/sourceUi';
import { SessionSource } from '../../src/types/index';

const ALL_SOURCES: SessionSource[] = ['copilot', 'claude', 'cline', 'roocode', 'cursor', 'windsurf', 'aider', 'antigravity'];

// ------------------------------------------------------------------ //
// friendlySourceName
// ------------------------------------------------------------------ //

suite('friendlySourceName', () => {
    test('copilot → GitHub Copilot', () => {
        assert.strictEqual(friendlySourceName('copilot'), 'GitHub Copilot');
    });

    test('claude → Claude Code', () => {
        assert.strictEqual(friendlySourceName('claude'), 'Claude Code');
    });

    test('cline → Cline', () => {
        assert.strictEqual(friendlySourceName('cline'), 'Cline');
    });

    test('roocode → Roo Code', () => {
        assert.strictEqual(friendlySourceName('roocode'), 'Roo Code');
    });

    test('cursor → Cursor', () => {
        assert.strictEqual(friendlySourceName('cursor'), 'Cursor');
    });

    test('windsurf → Windsurf', () => {
        assert.strictEqual(friendlySourceName('windsurf'), 'Windsurf');
    });

    test('aider → Aider', () => {
        assert.strictEqual(friendlySourceName('aider'), 'Aider');
    });

    test('antigravity → Google Antigravity', () => {
        assert.strictEqual(friendlySourceName('antigravity'), 'Google Antigravity');
    });

    test('all sources produce a non-empty string', () => {
        for (const source of ALL_SOURCES) {
            const name = friendlySourceName(source);
            assert.ok(typeof name === 'string' && name.length > 0, `Expected non-empty name for source '${source}'`);
        }
    });
});

// ------------------------------------------------------------------ //
// sourceCodiconId
// ------------------------------------------------------------------ //

suite('sourceCodiconId', () => {
    test('copilot → github', () => {
        assert.strictEqual(sourceCodiconId('copilot'), 'github');
    });

    test('claude → hubot', () => {
        assert.strictEqual(sourceCodiconId('claude'), 'hubot');
    });

    test('cline → plug', () => {
        assert.strictEqual(sourceCodiconId('cline'), 'plug');
    });

    test('roocode → circuit-board', () => {
        assert.strictEqual(sourceCodiconId('roocode'), 'circuit-board');
    });

    test('cursor → sparkle', () => {
        assert.strictEqual(sourceCodiconId('cursor'), 'sparkle');
    });

    test('windsurf → cloud', () => {
        assert.strictEqual(sourceCodiconId('windsurf'), 'cloud');
    });

    test('aider → terminal', () => {
        assert.strictEqual(sourceCodiconId('aider'), 'terminal');
    });

    test('antigravity → rocket', () => {
        assert.strictEqual(sourceCodiconId('antigravity'), 'rocket');
    });

    test('all sources return a non-empty string', () => {
        for (const source of ALL_SOURCES) {
            const id = sourceCodiconId(source);
            assert.ok(typeof id === 'string' && id.length > 0, `Expected non-empty codicon id for '${source}'`);
        }
    });
});

// ------------------------------------------------------------------ //
// sourceBadgeClass
// ------------------------------------------------------------------ //

suite('sourceBadgeClass', () => {
    test('known source returns its specific badge class', () => {
        assert.strictEqual(sourceBadgeClass('copilot'), 'cw-badge-copilot');
        assert.strictEqual(sourceBadgeClass('claude'), 'cw-badge-claude');
        assert.strictEqual(sourceBadgeClass('cline'), 'cw-badge-cline');
        assert.strictEqual(sourceBadgeClass('roocode'), 'cw-badge-roocode');
        assert.strictEqual(sourceBadgeClass('cursor'), 'cw-badge-cursor');
        assert.strictEqual(sourceBadgeClass('windsurf'), 'cw-badge-windsurf');
        assert.strictEqual(sourceBadgeClass('aider'), 'cw-badge-aider');
        assert.strictEqual(sourceBadgeClass('antigravity'), 'cw-badge-antigravity');
    });

    test('unknown source falls back to cw-badge-claude', () => {
        assert.strictEqual(sourceBadgeClass('unknownsource'), 'cw-badge-claude');
    });

    test('empty string falls back to cw-badge-claude', () => {
        assert.strictEqual(sourceBadgeClass(''), 'cw-badge-claude');
    });

    test('SOURCE_BADGE_CLASS record covers all known sources', () => {
        for (const source of ALL_SOURCES) {
            assert.ok(
                Object.prototype.hasOwnProperty.call(SOURCE_BADGE_CLASS, source),
                `Expected SOURCE_BADGE_CLASS to have key '${source}'`
            );
        }
    });
});
