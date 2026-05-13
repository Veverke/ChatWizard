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
    // 1.4.0 additions
    'chatwizard.rotateMcpToken',
    'chatwizard.connectCopilot',
    'chatwizard.setupGlobalInstructions',
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

    // ── Test 3c: chat participant commands registered at runtime ─────────
    // chatwizard.query.continued and chatwizard.query.general are NOT declared
    // in package.json — they are registered dynamically by registerChatParticipant()
    // at activation time. If they go missing (e.g. due to a refactor), the "Yes"
    // and "No" buttons in the chat participant stream would silently do nothing.

    test('chat participant button commands are registered at runtime', async () => {
        const registeredCommands = await vscode.commands.getCommands(true);
        const PARTICIPANT_COMMANDS = [
            'chatwizard.query.continued',
            'chatwizard.query.general',
        ];
        const missing = PARTICIPANT_COMMANDS.filter(cmd => !registeredCommands.includes(cmd));
        assert.deepStrictEqual(
            missing,
            [],
            `Chat participant commands not registered at runtime: ${missing.join(', ')}`,
        );
    });

    // ── Test 3d: chat participant declared in package.json ───────────────
    // Verifies that the @chatwizard participant and its /queryHistory and
    // /continueFromHistory slash commands are declared in contributes.chatParticipants.
    // A mismatch here means the slash commands are invisible in the VS Code chat UI.

    test('chat participant slash commands declared in package.json', () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, 'extension must be present');

        const pkg = ext!.packageJSON as {
            contributes?: {
                chatParticipants?: Array<{
                    id: string;
                    commands?: Array<{ name: string }>;
                }>;
            };
        };

        const participants = pkg.contributes?.chatParticipants ?? [];
        const chatwizardParticipant = participants.find(p => p.id === 'Veverke.chatwizard');
        assert.ok(chatwizardParticipant, 'Veverke.chatwizard chat participant not declared in package.json');

        const declaredCommands = (chatwizardParticipant!.commands ?? []).map(c => c.name);
        for (const expectedCmd of ['queryHistory', 'continueFromHistory']) {
            assert.ok(
                declaredCommands.includes(expectedCmd),
                `Slash command "/${expectedCmd}" not declared in contributes.chatParticipants`,
            );
        }

        // Verify removed commands are NOT present (guards against accidental re-addition)
        for (const removedCmd of ['answerFromHistory', 'troubleshootFromHistory', 'debugWithHistory']) {
            assert.ok(
                !declaredCommands.includes(removedCmd),
                `Removed command "/${removedCmd}" should NOT be in package.json — was it re-added accidentally?`,
            );
        }
    });
});
