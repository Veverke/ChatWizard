// test/suite/manageWorkspacesCommand.test.ts
//
// Unit tests for the manage-workspaces command logic.
// These tests exercise the selection-validation and scope-manager update behaviour
// without spinning up a full VS Code extension host.

import * as assert from 'assert';
import { ScopedWorkspace } from '../../src/types/index';
import { WorkspaceScopeManager, calcWorkspaceSizeMb } from '../../src/watcher/workspaceScope';

// ---------------------------------------------------------------------------
// Minimal in-memory GlobalState stub
// ---------------------------------------------------------------------------
class FakeGlobalState {
    private _store = new Map<string, unknown>();

    get<T>(key: string): T | undefined {
        return this._store.get(key) as T | undefined;
    }

    async update(key: string, value: unknown): Promise<void> {
        this._store.set(key, value);
    }
}

function makeContext(): { globalState: FakeGlobalState } {
    return { globalState: new FakeGlobalState() };
}

// ---------------------------------------------------------------------------
// Fake ScopedWorkspace helpers
// ---------------------------------------------------------------------------
function makeScopedWorkspace(id: string, source: 'copilot' | 'claude' = 'copilot'): ScopedWorkspace {
    return {
        id,
        source,
        workspacePath: `/fake/${id}`,
        storageDir: `/fake/${id}/storage`,
    };
}

// ---------------------------------------------------------------------------
// Helper: simulates the command's selection-validation logic in isolation.
// Each "picked" item carries wsIds (all source IDs for that folder row).
// `undefined` = cancelled (Escape); non-empty array = confirmed selection.
// (An empty array cannot happen in practice — onDidAccept blocks it — so
//  we treat it the same as cancel here for completeness.)
// Returns the IDs that would be persisted, or `null` meaning "no-op / rejected".
// ---------------------------------------------------------------------------
function simulateSelectionCommit(
    scopeManager: WorkspaceScopeManager,
    picked: Array<{ wsIds: string[] }> | undefined
): string[] | null {
    // Cancelled (or accept blocked because nothing was selected)
    if (picked === undefined || picked.length === 0) { return null; }

    // Expand folder rows to individual source IDs
    const newIds = picked.flatMap(item => item.wsIds);

    // Unchanged check
    const sortedNew = [...newIds].sort();
    const sortedCurrent = [...scopeManager.getSelectedIds()].sort();
    const unchanged =
        sortedNew.length === sortedCurrent.length &&
        sortedNew.every((id, i) => id === sortedCurrent[i]);

    if (unchanged) { return null; }

    // Commit
    scopeManager.setSelectedIds(newIds);
    return newIds;
}

// ---------------------------------------------------------------------------
// Suite: empty-selection guard
// ---------------------------------------------------------------------------
suite('manageWorkspacesCommand — empty-selection guard', () => {

    test('null (cancelled) → scope manager not updated', async () => {
        const ctx = makeContext();
        const mgr = new WorkspaceScopeManager(ctx);
        mgr.setSelectedIds(['ws-a']); // simulate prior state

        const result = simulateSelectionCommit(mgr, undefined);

        assert.strictEqual(result, null, 'should return null on cancel');
        // Persisted IDs unchanged
        assert.deepStrictEqual(mgr.getSelectedIds(), ['ws-a']);
    });

    test('empty array (accept blocked, treated same as cancel) → scope manager not updated', async () => {
        const ctx = makeContext();
        const mgr = new WorkspaceScopeManager(ctx);
        mgr.setSelectedIds(['ws-a']); // simulate prior state

        const result = simulateSelectionCommit(mgr, []);

        assert.strictEqual(result, null, 'should return null when no items selected');
        // Persisted IDs unchanged
        assert.deepStrictEqual(mgr.getSelectedIds(), ['ws-a']);
    });
});

// ---------------------------------------------------------------------------
// Suite: successful selection changes
// ---------------------------------------------------------------------------
suite('manageWorkspacesCommand — successful selection changes', () => {

    test('adding a new workspace updates the scope manager', async () => {
        const ctx = makeContext();
        const wsA = makeScopedWorkspace('ws-a');
        const wsB = makeScopedWorkspace('ws-b');
        const mgr = new WorkspaceScopeManager(ctx);
        await mgr.initDefault([wsA, wsB]);

        // Scope starts with both (no match for current folder → all)
        // Simulate user selecting only ws-a (one folder row with a single source ID)
        const result = simulateSelectionCommit(mgr, [{ wsIds: ['ws-a'] }]);
        assert.deepStrictEqual(result, ['ws-a']);
        assert.deepStrictEqual(mgr.getSelectedIds(), ['ws-a']);
    });

    test('selecting a subset persists only that subset', async () => {
        const ctx = makeContext();
        const workspaces = ['ws-1', 'ws-2', 'ws-3'].map(id => makeScopedWorkspace(id));
        const mgr = new WorkspaceScopeManager(ctx);
        await mgr.initDefault(workspaces);

        const result = simulateSelectionCommit(mgr, [{ wsIds: ['ws-1'] }, { wsIds: ['ws-3'] }]);

        assert.ok(result !== null);
        assert.deepStrictEqual([...result!].sort(), ['ws-1', 'ws-3']);
        assert.deepStrictEqual([...mgr.getSelectedIds()].sort(), ['ws-1', 'ws-3']);
    });

    test('selecting all workspaces is a valid commit', async () => {
        const ctx = makeContext();
        const workspaces = ['ws-a', 'ws-b'].map(id => makeScopedWorkspace(id));
        const mgr = new WorkspaceScopeManager(ctx);
        // Pre-set scope to only ws-a
        mgr.setSelectedIds(['ws-a']);

        const result = simulateSelectionCommit(mgr, [{ wsIds: ['ws-a'] }, { wsIds: ['ws-b'] }]);

        assert.ok(result !== null);
        assert.deepStrictEqual([...result!].sort(), ['ws-a', 'ws-b']);
    });
});

// ---------------------------------------------------------------------------
// Suite: unchanged selection → no-op
// ---------------------------------------------------------------------------
suite('manageWorkspacesCommand — unchanged selection', () => {

    test('confirming the same selection returns null (no-op)', async () => {
        const ctx = makeContext();
        const mgr = new WorkspaceScopeManager(ctx);
        mgr.setSelectedIds(['ws-x']); // simulate prior state

        const idsBefore = mgr.getSelectedIds().slice();
        const result = simulateSelectionCommit(mgr, [{ wsIds: ['ws-x'] }]);

        assert.strictEqual(result, null, 'should be a no-op when selection is unchanged');
        assert.deepStrictEqual(mgr.getSelectedIds(), idsBefore);
    });

    test('confirming same multi-workspace selection in different order is a no-op', async () => {
        const ctx = makeContext();
        const workspaces = ['ws-a', 'ws-b', 'ws-c'].map(id => makeScopedWorkspace(id));
        const mgr = new WorkspaceScopeManager(ctx);
        mgr.setSelectedIds(['ws-a', 'ws-b', 'ws-c']);

        const result = simulateSelectionCommit(
            mgr,
            [{ wsIds: ['ws-c'] }, { wsIds: ['ws-a'] }, { wsIds: ['ws-b'] }]
        );

        assert.strictEqual(result, null, 'order should not matter for unchanged check');
    });
});

// ---------------------------------------------------------------------------
// Suite: mixed Copilot + Claude workspaces
// ---------------------------------------------------------------------------
suite('manageWorkspacesCommand — mixed sources', () => {

    test('a folder row with both copilot and claude IDs selects all of them', async () => {
        const ctx = makeContext();
        const mgr = new WorkspaceScopeManager(ctx);
        mgr.setSelectedIds(['copilot-abc123']);

        // The picker groups both sources under one folder row
        const result = simulateSelectionCommit(
            mgr,
            [{ wsIds: ['copilot-abc123', 'c--Repos-proj'] }]
        );

        assert.ok(result !== null);
        assert.deepStrictEqual([...result!].sort(), ['c--Repos-proj', 'copilot-abc123']);
    });

    test('deselecting a folder with two sources removes all its IDs', async () => {
        const ctx = makeContext();
        const mgr = new WorkspaceScopeManager(ctx);
        // Two folders: A (has copilot+claude), B (copilot only)
        mgr.setSelectedIds(['copilot-A', 'claude-A', 'copilot-B']);

        // User unchecks folder A, keeps folder B
        const result = simulateSelectionCommit(mgr, [{ wsIds: ['copilot-B'] }]);

        assert.ok(result !== null);
        assert.deepStrictEqual(result, ['copilot-B']);
        assert.deepStrictEqual(mgr.getSelectedIds(), ['copilot-B']);
    });
});
