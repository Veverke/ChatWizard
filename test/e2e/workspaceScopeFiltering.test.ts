// test/e2e/workspaceScopeFiltering.test.ts
//
// Workspace-scope filtering tests for every non-Copilot source.
//
// These tests exercise `filterSessionsByWorkspaceScope` — the pure helper that
// `buildInitialIndex()` uses to scope path-based sources (Cline, Roo Code,
// Aider) to the currently open VS Code folders. Copilot/Claude/Cursor/Windsurf
// are filtered upstream by persisted workspace IDs, so they must pass through
// unchanged. Sources with no workspace path (Antigravity, Continue, Amazon Q,
// Gemini, Tabnine, Zed) cannot be scoped by path and are kept as-is.

import * as assert from 'assert';
import * as path from 'path';
import { filterSessionsByWorkspaceScope } from '../../src/watcher/fileWatcher';
import { Session, SessionSource } from '../../src/types/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(id: string, source: SessionSource, workspacePath?: string): Session {
    return {
        id,
        title: `Session ${id}`,
        source,
        workspaceId: `ws-${id}`,
        workspacePath,
        messages: [],
        filePath: `/fake/${source}/${id}.jsonl`,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
    };
}

// On Windows paths are case-insensitive; normalize consistently.
function norm(p: string): string {
    return path.normalize(p);
}

// ---------------------------------------------------------------------------
// Path-scoped sources: Cline, Roo Code, Aider
// ---------------------------------------------------------------------------

suite('Workspace scope filtering — path-scoped sources', () => {

    const openFolders = [norm('/Users/dev/project-a')];

    test('cline: keeps sessions under the open folder', () => {
        const sessions = [
            makeSession('c1', 'cline', norm('/Users/dev/project-a/tasks/t1')),
            makeSession('c2', 'cline', norm('/Users/dev/other-project/tasks/t2')),
        ];
        const result = filterSessionsByWorkspaceScope(sessions, [], openFolders);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 'c1');
    });

    test('cline: drops sessions with no workspacePath', () => {
        const sessions = [
            makeSession('c1', 'cline', norm('/Users/dev/project-a/tasks/t1')),
            makeSession('c2', 'cline', undefined),
        ];
        const result = filterSessionsByWorkspaceScope(sessions, [], openFolders);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 'c1');
    });

    test('roocode: keeps sessions under the open folder', () => {
        const sessions = [
            makeSession('r1', 'roocode', norm('/Users/dev/project-a/tasks/t1')),
            makeSession('r2', 'roocode', norm('/Users/dev/elsewhere')),
        ];
        const result = filterSessionsByWorkspaceScope(sessions, [], openFolders);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 'r1');
    });

    test('aider: keeps sessions under the open folder', () => {
        const sessions = [
            makeSession('a1', 'aider', norm('/Users/dev/project-a')),
            makeSession('a2', 'aider', norm('/Users/dev/project-b')),
        ];
        const result = filterSessionsByWorkspaceScope(sessions, [], openFolders);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 'a1');
    });

    test('multiple open folders: keeps sessions under any of them', () => {
        const open = [norm('/Users/dev/project-a'), norm('/Users/dev/project-b')];
        const sessions = [
            makeSession('s1', 'cline', norm('/Users/dev/project-a/tasks/t1')),
            makeSession('s2', 'roocode', norm('/Users/dev/project-b/tasks/t2')),
            makeSession('s3', 'aider', norm('/Users/dev/project-c')),
        ];
        const result = filterSessionsByWorkspaceScope(sessions, [], open);
        assert.strictEqual(result.length, 2);
        const ids = result.map(s => s.id).sort();
        assert.deepStrictEqual(ids, ['s1', 's2']);
    });

    test('subfolder match: path must be under the open folder, not a sibling prefix', () => {
        // "project-a" should NOT match "project-ab" or "project-a-copy"
        const open = [norm('/Users/dev/project-a')];
        const sessions = [
            makeSession('s1', 'cline', norm('/Users/dev/project-a/tasks/t1')),   // keep
            makeSession('s2', 'cline', norm('/Users/dev/project-ab/tasks/t2')),  // drop
            makeSession('s3', 'cline', norm('/Users/dev/project-a-copy/t3')),    // drop
        ];
        const result = filterSessionsByWorkspaceScope(sessions, [], open);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].id, 's1');
    });

    test('exact folder match keeps the session', () => {
        const open = [norm('/Users/dev/project-a')];
        const sessions = [
            makeSession('s1', 'aider', norm('/Users/dev/project-a')),
            makeSession('s2', 'aider', norm('/Users/dev/project-a/subdir')),
        ];
        const result = filterSessionsByWorkspaceScope(sessions, [], open);
        assert.strictEqual(result.length, 2);
    });
});

// ---------------------------------------------------------------------------
// ID-scoped sources: Copilot, Claude, Cursor, Windsurf
// ---------------------------------------------------------------------------

suite('Workspace scope filtering — ID-scoped sources pass through', () => {

    const openFolders = [norm('/Users/dev/project-a')];

    test('copilot: not re-filtered by path (already ID-scoped upstream)', () => {
        const sessions = [
            makeSession('cp1', 'copilot', norm('/Users/dev/other')),
            makeSession('cp2', 'copilot', norm('/Users/dev/project-a')),
        ];
        const result = filterSessionsByWorkspaceScope(sessions, [], openFolders);
        assert.strictEqual(result.length, 2);
    });

    test('claude: not re-filtered by path', () => {
        const sessions = [
            makeSession('cl1', 'claude', norm('/Users/dev/other')),
            makeSession('cl2', 'claude', norm('/Users/dev/project-a')),
        ];
        const result = filterSessionsByWorkspaceScope(sessions, [], openFolders);
        assert.strictEqual(result.length, 2);
    });

    test('cursor: not re-filtered by path', () => {
        const sessions = [
            makeSession('cu1', 'cursor', norm('/Users/dev/other')),
            makeSession('cu2', 'cursor', norm('/Users/dev/project-a')),
        ];
        const result = filterSessionsByWorkspaceScope(sessions, [], openFolders);
        assert.strictEqual(result.length, 2);
    });

    test('windsurf: not re-filtered by path', () => {
        const sessions = [
            makeSession('w1', 'windsurf', norm('/Users/dev/other')),
            makeSession('w2', 'windsurf', norm('/Users/dev/project-a')),
        ];
        const result = filterSessionsByWorkspaceScope(sessions, [], openFolders);
        assert.strictEqual(result.length, 2);
    });
});

// ---------------------------------------------------------------------------
// Sources with no workspace path: Antigravity, Continue, Amazon Q, Gemini,
// Tabnine, Zed
// ---------------------------------------------------------------------------

suite('Workspace scope filtering — no-workspace-path sources kept', () => {

    const openFolders = [norm('/Users/dev/project-a')];

    test('antigravity: kept even with no workspacePath', () => {
        const sessions = [
            makeSession('ag1', 'antigravity', undefined),
            makeSession('ag2', 'antigravity', undefined),
        ];
        const result = filterSessionsByWorkspaceScope(sessions, [], openFolders);
        assert.strictEqual(result.length, 2);
    });

    test('continue: kept even with no workspacePath', () => {
        const sessions = [makeSession('co1', 'continue', undefined)];
        const result = filterSessionsByWorkspaceScope(sessions, [], openFolders);
        assert.strictEqual(result.length, 1);
    });

    test('amazonq: kept even with no workspacePath', () => {
        const sessions = [makeSession('aq1', 'amazonq', undefined)];
        const result = filterSessionsByWorkspaceScope(sessions, [], openFolders);
        assert.strictEqual(result.length, 1);
    });

    test('geminiCodeAssist: kept even with no workspacePath', () => {
        const sessions = [makeSession('g1', 'geminiCodeAssist', undefined)];
        const result = filterSessionsByWorkspaceScope(sessions, [], openFolders);
        assert.strictEqual(result.length, 1);
    });

    test('tabnine: kept even with no workspacePath', () => {
        const sessions = [makeSession('t1', 'tabnine', undefined)];
        const result = filterSessionsByWorkspaceScope(sessions, [], openFolders);
        assert.strictEqual(result.length, 1);
    });

    test('zed: kept even with no workspacePath', () => {
        const sessions = [makeSession('z1', 'zed', undefined)];
        const result = filterSessionsByWorkspaceScope(sessions, [], openFolders);
        assert.strictEqual(result.length, 1);
    });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

suite('Workspace scope filtering — edge cases', () => {

    test('no open folders and no selected IDs → returns everything unchanged', () => {
        const sessions = [
            makeSession('s1', 'cline', norm('/Users/dev/project-a')),
            makeSession('s2', 'copilot', norm('/Users/dev/other')),
        ];
        const result = filterSessionsByWorkspaceScope(sessions, [], []);
        assert.strictEqual(result.length, 2);
    });

    test('open folders set but sessions empty → empty result', () => {
        const result = filterSessionsByWorkspaceScope([], [], [norm('/Users/dev/project-a')]);
        assert.deepStrictEqual(result, []);
    });

    test('selected IDs set but no open folders → path-scoped sources pass through', () => {
        // This mirrors the legacy behavior where only selectedIds were used:
        // without open folders we cannot path-filter, so nothing is dropped.
        const sessions = [
            makeSession('s1', 'cline', norm('/Users/dev/anywhere')),
            makeSession('s2', 'cline', norm('/Users/dev/elsewhere')),
        ];
        const result = filterSessionsByWorkspaceScope(sessions, ['ws-1'], []);
        assert.strictEqual(result.length, 2);
    });

    test('mixed sources: only path-scoped sources are filtered', () => {
        const open = [norm('/Users/dev/project-a')];
        const sessions = [
            makeSession('cline-match', 'cline', norm('/Users/dev/project-a/tasks/t1')),
            makeSession('cline-miss', 'cline', norm('/Users/dev/other/tasks/t2')),
            makeSession('roo-match', 'roocode', norm('/Users/dev/project-a/tasks/t3')),
            makeSession('aider-miss', 'aider', norm('/Users/dev/nowhere')),
            makeSession('copilot-any', 'copilot', norm('/Users/dev/whatever')),
            makeSession('ag-no-path', 'antigravity', undefined),
        ];
        const result = filterSessionsByWorkspaceScope(sessions, [], open);
        const ids = result.map(s => s.id).sort();
        assert.deepStrictEqual(ids, [
            'ag-no-path',
            'cline-match',
            'copilot-any',
            'roo-match',
        ]);
    });
});