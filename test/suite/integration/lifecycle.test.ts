// test/suite/integration/lifecycle.test.ts
//
// Integration tests — Extension Lifecycle (scenarios 1–3)
//
// These tests run inside the VS Code Extension Development Host and require
// the vscode API. They verify the extension activates correctly and that all
// contributed commands are registered.

import * as assert from 'assert';
import * as vscode from 'vscode';

// The publisher.name used in package.json
const EXTENSION_ID = 'Veverke.chatwizard';

// Subset of contributed commands expected to be registered after activation.
// (Full list is in package.json contributes.commands — we check the most important ones.)
const EXPECTED_COMMANDS = [
    'chatwizard.openSession',
    'chatwizard.openSessionFromCodeBlock',
    'chatwizard.search',
    'chatwizard.filterSessions',
    'chatwizard.filterCodeBlocks',
    'chatwizard.configureSortOrder',
    'chatwizard.sortByDate',
    'chatwizard.sortByDate.asc',
    'chatwizard.sortByDate.desc',
    'chatwizard.sortByWorkspace',
    'chatwizard.sortByLength',
    'chatwizard.sortByTitle',
    'chatwizard.sortByModel',
    'chatwizard.pinSession',
    'chatwizard.unpinSession',
    'chatwizard.loadMoreSessions',
    'chatwizard.loadMoreCodeBlocks',
    'chatwizard.enableSessionGrouping',
    'chatwizard.disableSessionGrouping',
    'chatwizard.enableCbGrouping',
    'chatwizard.disableCbGrouping',
    'chatwizard.exportSession',
    'chatwizard.exportAll',
    'chatwizard.exportSelected',
    'chatwizard.exportExcerpt',
    'chatwizard.exportFromTreeSelection',
    'chatwizard.manageWatchedWorkspaces',
];

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('Extension Lifecycle', function () {
    // Activation can take a moment on a cold start
    this.timeout(15_000);

    // Ensure the extension is active before any test runs in this suite
    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        if (ext && !ext.isActive) {
            await ext.activate();
        }
    });

    // ── Test 1: extension is present ──────────────────────────────────────

    test('extension is present in the host', () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `Extension "${EXTENSION_ID}" not found — is it installed in the test host?`);
    });

    // ── Test 2: extension activates without error ─────────────────────────

    test('extension activates successfully', async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, 'extension not found');
        if (!ext.isActive) {
            await ext.activate();
        }
        assert.ok(ext.isActive, 'extension did not become active');
    });

    // ── Test 3: all contributed commands are registered ───────────────────

    test('all expected commands are registered', async () => {
        const registeredCommands = await vscode.commands.getCommands(/* filterInternal */ true);
        const missing: string[] = [];
        for (const cmd of EXPECTED_COMMANDS) {
            if (!registeredCommands.includes(cmd)) {
                missing.push(cmd);
            }
        }
        assert.deepStrictEqual(
            missing,
            [],
            `These commands were not registered: ${missing.join(', ')}`
        );
    });

    // ── Test 3b: contributed views exist (extension active → views registered)

    test('all contributed view IDs are declared in package.json and extension is active', () => {
        // VS Code has no public API to enumerate registered views at runtime.
        // We assert indirectly: if the extension is active the contributes.views
        // entries are registered as part of the activation path.
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext?.isActive, 'extension must be active for views to be registered');

        const EXPECTED_VIEW_IDS = [
            'chatwizardSessions',
            'chatwizardPromptLibrary',
            'chatwizardCodeBlocks',
            'chatwizardAnalytics',
            'chatwizardModelUsage',
            'chatwizardTimeline',
        ];

        // Verify all expected IDs appear in the extension's package.json metadata
        const pkg = ext.packageJSON as {
            contributes?: {
                views?: Record<string, Array<{ id: string }>>;
            };
        };
        const declaredIds = Object.values(pkg.contributes?.views ?? {})
            .flat()
            .map((v) => v.id);

        for (const id of EXPECTED_VIEW_IDS) {
            assert.ok(
                declaredIds.includes(id),
                `View "${id}" is not declared in package.json contributes.views`
            );
        }
    });
});
