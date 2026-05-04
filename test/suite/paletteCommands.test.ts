// test/suite/paletteCommands.test.ts
//
// Unit tests for the command-palette category mapping.
//
// Verifies that:
//   1. All palette-accessible leaf commands are covered in exactly one category.
//   2. No command ID is duplicated across categories.
//   3. Every category command ID matches the registered set.
//   4. The data structure is internally consistent (non-empty, valid shapes).
//
// These tests are purely data-driven — no VS Code extension host needed.

import * as assert from 'assert';
import { PALETTE_CATEGORIES, PaletteCategory } from '../../src/commands/paletteCommandsData';

// ---------------------------------------------------------------------------
// Authoritative list of leaf commands that MUST appear in the mapping.
// Update this whenever a new user-facing palette command is added or removed.
// ---------------------------------------------------------------------------
const EXPECTED_LEAF_COMMANDS: ReadonlySet<string> = new Set([
    // Views
    'chatwizard.showCodeBlocks',
    'chatwizard.showPromptLibrary',
    'chatwizard.showAnalytics',
    'chatwizard.showTimeline',
    // Search
    'chatwizard.search',
    'chatwizard.semanticSearch',
    // Organise
    'chatwizard.filterSessions',
    'chatwizard.configureSortOrder',
    'chatwizard.filterCodeBlocks',
    // Export
    'chatwizard.exportAll',
    'chatwizard.exportSelected',
    'chatwizard.exportExcerpt',
    // Workspace
    'chatwizard.manageWatchedWorkspaces',
    'chatwizard.rescan',
    // MCP server
    'chatwizard.startMcpServer',
    'chatwizard.stopMcpServer',
    'chatwizard.copyMcpConfig',
]);

// Authoritative set of top-level category command IDs contributed to the palette.
const EXPECTED_CATEGORY_IDS: ReadonlySet<string> = new Set([
    'chatwizard.views',
    'chatwizard.searchMenu',
    'chatwizard.organise',
    'chatwizard.export',
    'chatwizard.workspace',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectAllLeafIds(cats: readonly PaletteCategory[]): string[] {
    return cats.flatMap(c => c.items.map(i => i.commandId));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('paletteCommands — data structure', () => {

    test('PALETTE_CATEGORIES is a non-empty array', () => {
        assert.ok(Array.isArray(PALETTE_CATEGORIES));
        assert.ok(PALETTE_CATEGORIES.length > 0, 'Expected at least one category');
    });

    test('each category has non-empty commandId, title, icon, and items', () => {
        for (const cat of PALETTE_CATEGORIES) {
            assert.ok(cat.commandId.trim(), `Category missing commandId: ${JSON.stringify(cat)}`);
            assert.ok(cat.title.trim(),     `Category "${cat.commandId}" has empty title`);
            assert.ok(cat.icon.trim(),      `Category "${cat.commandId}" has empty icon`);
            assert.ok(Array.isArray(cat.items) && cat.items.length > 0,
                `Category "${cat.commandId}" has no items`);
        }
    });

    test('each item has non-empty commandId, label, and icon', () => {
        for (const cat of PALETTE_CATEGORIES) {
            for (const item of cat.items) {
                assert.ok(item.commandId.trim(),
                    `Item in category "${cat.commandId}" has empty commandId`);
                assert.ok(item.label.trim(),
                    `Item "${item.commandId}" in "${cat.commandId}" has empty label`);
                assert.ok(item.icon.trim(),
                    `Item "${item.commandId}" in "${cat.commandId}" has empty icon`);
            }
        }
    });

});

suite('paletteCommands — no duplicates', () => {

    test('no leaf command ID appears in more than one category', () => {
        const seen = new Set<string>();
        for (const cat of PALETTE_CATEGORIES) {
            for (const item of cat.items) {
                assert.ok(!seen.has(item.commandId),
                    `Duplicate leaf command "${item.commandId}" found in palette map`);
                seen.add(item.commandId);
            }
        }
    });

    test('no category commandId is duplicated', () => {
        const ids = PALETTE_CATEGORIES.map(c => c.commandId);
        const unique = new Set(ids);
        assert.strictEqual(unique.size, ids.length,
            `Duplicate category commandId detected: ${ids.join(', ')}`);
    });

});

suite('paletteCommands — completeness', () => {

    test('every expected leaf command is mapped to a category', () => {
        const mapped = new Set(collectAllLeafIds(PALETTE_CATEGORIES));
        for (const expected of EXPECTED_LEAF_COMMANDS) {
            assert.ok(mapped.has(expected),
                `Expected command "${expected}" is not mapped to any palette category`);
        }
    });

    test('no undeclared leaf command is present in the mapping', () => {
        for (const id of collectAllLeafIds(PALETTE_CATEGORIES)) {
            assert.ok(EXPECTED_LEAF_COMMANDS.has(id),
                `Unexpected command "${id}" found in palette map — ` +
                `add it to EXPECTED_LEAF_COMMANDS or remove it from PALETTE_CATEGORIES`);
        }
    });

    test('every expected category command ID is present', () => {
        const actual = new Set(PALETTE_CATEGORIES.map(c => c.commandId));
        for (const expected of EXPECTED_CATEGORY_IDS) {
            assert.ok(actual.has(expected),
                `Expected category command "${expected}" not found in PALETTE_CATEGORIES`);
        }
    });

    test('no undeclared category command ID is present', () => {
        for (const cat of PALETTE_CATEGORIES) {
            assert.ok(EXPECTED_CATEGORY_IDS.has(cat.commandId),
                `Unexpected category "${cat.commandId}" found — ` +
                `add it to EXPECTED_CATEGORY_IDS or remove it from PALETTE_CATEGORIES`);
        }
    });

    test('total leaf count matches EXPECTED_LEAF_COMMANDS size', () => {
        const allLeafs = collectAllLeafIds(PALETTE_CATEGORIES);
        assert.strictEqual(
            allLeafs.length,
            EXPECTED_LEAF_COMMANDS.size,
            `Leaf count mismatch: mapping has ${allLeafs.length}, expected ${EXPECTED_LEAF_COMMANDS.size}`
        );
    });

});
