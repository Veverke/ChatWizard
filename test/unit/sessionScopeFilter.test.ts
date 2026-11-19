// test/unit/sessionScopeFilter.test.ts
//
// Workspace-scope rule — pure unit tests.
//
// `isPathInScope` / `filterSessionsByWorkspaceScope` are used by the batch
// collector and the SQLite cache restore, while `isSessionInScope` guards the
// ingestion paths that bypass the batch collector (live file watchers, archive
// restore). Both must agree, otherwise a chat from another repository leaks
// into the Sessions view after a live update — which is exactly the bug these
// tests pin down (see `isSessionInScope` docs).

import * as assert from 'assert';
import * as path from 'path';
import {
    GLOBAL_WORKSPACE_IDS,
    claudeProjectDirId,
    filterSessionsByWorkspaceScope,
    isPathInScope,
    isPathScopedSession,
    isSessionInScope,
} from '../../src/watcher/sessionScopeFilter';
import { Session, SessionSource } from '../../src/types/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SessionOpts {
    workspaceId?: string;
    workspacePath?: string;
    filePath?: string;
}

function makeSession(id: string, source: SessionSource, opts: SessionOpts = {}): Session {
    return {
        id,
        title: `Session ${id}`,
        source,
        workspaceId: opts.workspaceId ?? `ws-${id}`,
        workspacePath: opts.workspacePath,
        messages: [],
        filePath: opts.filePath ?? path.join(path.sep, 'fake', source, `${id}.jsonl`),
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
    };
}

const SELLING = path.normalize(path.join(path.sep, 'repo', 'selling'));
const CHATWIZARD = path.normalize(path.join(path.sep, 'repo', 'ChatWizard'));

/** Claude project dir name for a `~/.claude/projects/<name>/<session>.jsonl` file. */
function claudeFilePath(projectDirName: string, sessionId: string): string {
    return path.normalize(
        path.join(path.sep, 'home', 'dev', '.claude', 'projects', projectDirName, `${sessionId}.jsonl`)
    );
}

// ---------------------------------------------------------------------------
// isPathInScope
// ---------------------------------------------------------------------------

suite('isPathInScope', () => {

    test('matches the open folder exactly', () => {
        assert.strictEqual(isPathInScope(SELLING, [SELLING]), true);
    });

    test('matches a nested (sub-directory) workspace path', () => {
        const nested = path.join(SELLING, 'selling-service', 'tasks', 't1');
        assert.strictEqual(isPathInScope(nested, [SELLING]), true);
    });

    test('rejects a sibling folder sharing the same prefix', () => {
        const sibling = `${SELLING}-other`;
        assert.strictEqual(isPathInScope(sibling, [SELLING]), false);
    });

    test('rejects a path outside every open folder', () => {
        assert.strictEqual(isPathInScope(CHATWIZARD, [SELLING]), false);
    });

    test('rejects an undefined workspace path while folders are open', () => {
        assert.strictEqual(isPathInScope(undefined, [SELLING]), false);
    });

    test('accepts everything when no folder is open', () => {
        assert.strictEqual(isPathInScope(CHATWIZARD, []), true);
        assert.strictEqual(isPathInScope(undefined, []), true);
    });

    test('comparison is case-insensitive', () => {
        const upper = SELLING.toUpperCase();
        const lowerPath = path.join(SELLING.toLowerCase(), 'sub');
        assert.strictEqual(isPathInScope(lowerPath, [upper]), true);
    });

    test('tolerates a trailing separator on the open folder', () => {
        const withSep = SELLING + path.sep;
        assert.strictEqual(isPathInScope(path.join(SELLING, 'a'), [withSep]), true);
    });
});


// ---------------------------------------------------------------------------
// isSessionInScope — path-scoped sources (Cline / Roo Code / Aider)
// ---------------------------------------------------------------------------

suite('isSessionInScope — path-scoped sources', () => {

    test('cline inside the open folder is in scope', () => {
        const s = makeSession('c1', 'cline', { workspacePath: SELLING });
        assert.strictEqual(isSessionInScope(s, [], [SELLING]), true);
    });

    test('cline in another repository is NOT in scope (the reported bug)', () => {
        const s = makeSession('c2', 'cline', { workspacePath: CHATWIZARD });
        assert.strictEqual(isSessionInScope(s, ['some-workspace-id'], [SELLING]), false);
    });

    test('cline without a workspace path is NOT in scope', () => {
        const s = makeSession('c3', 'cline');
        assert.strictEqual(isSessionInScope(s, [], [SELLING]), false);
    });

    test('roocode follows the same path rule', () => {
        const inside = makeSession('r1', 'roocode', { workspacePath: path.join(SELLING, 'x') });
        const outside = makeSession('r2', 'roocode', { workspacePath: CHATWIZARD });
        assert.strictEqual(isSessionInScope(inside, [], [SELLING]), true);
        assert.strictEqual(isSessionInScope(outside, [], [SELLING]), false);
    });

    test('aider follows the same path rule', () => {
        const inside = makeSession('a1', 'aider', { workspacePath: SELLING });
        const outside = makeSession('a2', 'aider', { workspacePath: CHATWIZARD });
        assert.strictEqual(isSessionInScope(inside, [], [SELLING]), true);
        assert.strictEqual(isSessionInScope(outside, [], [SELLING]), false);
    });

    test('copilot agent-host chat inside the open folder is in scope', () => {
        const s = makeSession('cp-agent-in', 'copilot', {
            workspaceId: 'copilot-agent',
            workspacePath: path.join(SELLING, 'src'),
        });
        assert.strictEqual(isSessionInScope(s, ['hash-selling'], [SELLING]), true);
    });

    test('copilot agent-host chat of another workspace is NOT in scope (the reported bug)', () => {
        // Every agent-host chat shares the global `copilot-agent` id, so the id
        // rule would keep them all. They must be scoped by their `cwd`.
        const s = makeSession('cp-agent-out', 'copilot', {
            workspaceId: 'copilot-agent',
            workspacePath: CHATWIZARD,
        });
        assert.strictEqual(isSessionInScope(s, ['hash-selling'], [SELLING]), false);
    });

    test('copilot agent-host chat without a cwd is NOT in scope while a folder is open', () => {
        const s = makeSession('cp-agent-nopath', 'copilot', { workspaceId: 'copilot-agent' });
        assert.strictEqual(isSessionInScope(s, ['hash-selling'], [SELLING]), false);
    });

    test('isPathScopedSession: only path-scoped sources and copilot-agent chats', () => {
        assert.strictEqual(isPathScopedSession(makeSession('p1', 'cline')), true);
        assert.strictEqual(isPathScopedSession(makeSession('p2', 'roocode')), true);
        assert.strictEqual(isPathScopedSession(makeSession('p3', 'aider')), true);
        assert.strictEqual(
            isPathScopedSession(makeSession('p4', 'copilot', { workspaceId: 'copilot-agent' })),
            true
        );
        // Legacy per-workspace Copilot chats stay id-scoped.
        assert.strictEqual(
            isPathScopedSession(makeSession('p5', 'copilot', { workspaceId: 'hash-selling' })),
            false
        );
        assert.strictEqual(isPathScopedSession(makeSession('p6', 'cursor')), false);
    });

    test('path-scoped sources pass when no folder is open (cannot be path-filtered)', () => {
        const s = makeSession('c4', 'cline', { workspacePath: CHATWIZARD });
        assert.strictEqual(isSessionInScope(s, ['some-workspace-id'], []), true);
    });

    test('nothing is filtered when neither ids nor folders are known', () => {
        const s = makeSession('c5', 'cline');
        assert.strictEqual(isSessionInScope(s, [], []), true);
    });
});

// ---------------------------------------------------------------------------
// isSessionInScope — id-scoped sources (Copilot / Claude / Cursor / Windsurf)
// ---------------------------------------------------------------------------

suite('isSessionInScope — id-scoped sources', () => {

    test('copilot: id in the selected ids is in scope', () => {
        const s = makeSession('cp1', 'copilot', { workspaceId: 'ws-selling' });
        assert.strictEqual(isSessionInScope(s, ['ws-selling'], [SELLING]), true);
    });

    test('copilot: id not selected is out of scope, even with a matching path', () => {
        const s = makeSession('cp2', 'copilot', { workspaceId: 'ws-other', workspacePath: SELLING });
        assert.strictEqual(isSessionInScope(s, ['ws-selling'], [SELLING]), false);
    });

    test('claude: scoped by project directory name, not by session.workspaceId', () => {
        const filePath = claudeFilePath('c--repo-selling', 'session-abc');
        const s = makeSession('cl1', 'claude', { workspaceId: 'session-abc', filePath, workspacePath: SELLING });
        assert.strictEqual(claudeProjectDirId(s), 'c--repo-selling');
        assert.strictEqual(isSessionInScope(s, ['c--repo-selling'], [SELLING]), true);
    });

    test('claude: a project directory outside the selection is out of scope', () => {
        const filePath = claudeFilePath('c--repo-ChatWizard', 'session-xyz');
        const s = makeSession('cl2', 'claude', { workspaceId: 'session-xyz', filePath, workspacePath: CHATWIZARD });
        assert.strictEqual(isSessionInScope(s, ['c--repo-selling'], [SELLING]), false);
    });

    test('cursor: id in the selection is in scope, other hashes are not', () => {
        const inside = makeSession('cu1', 'cursor', { workspaceId: 'hash-selling' });
        const outside = makeSession('cu2', 'cursor', { workspaceId: 'hash-other' });
        assert.strictEqual(isSessionInScope(inside, ['hash-selling'], [SELLING]), true);
        assert.strictEqual(isSessionInScope(outside, ['hash-selling'], [SELLING]), false);
    });

    test('windsurf: id in the selection is in scope, other hashes are not', () => {
        const inside = makeSession('w1', 'windsurf', { workspaceId: 'hash-selling' });
        const outside = makeSession('w2', 'windsurf', { workspaceId: 'hash-other' });
        assert.strictEqual(isSessionInScope(inside, ['hash-selling'], [SELLING]), true);
        assert.strictEqual(isSessionInScope(outside, ['hash-selling'], [SELLING]), false);
    });

    test('global workspace ids without a workspace path always pass', () => {
        // cursor-global / windsurf-global are machine-wide DBs with no path, so
        // they cannot be scoped at all.
        for (const globalId of GLOBAL_WORKSPACE_IDS.filter(id => id !== 'copilot-agent')) {
            const source: SessionSource = globalId.startsWith('cursor') ? 'cursor' : 'windsurf';
            const s = makeSession(`g-${globalId}`, source, { workspaceId: globalId, workspacePath: CHATWIZARD });
            assert.strictEqual(isSessionInScope(s, ['ws-selling'], [SELLING]), true, `${globalId} should pass`);
        }
    });

    test('copilot-agent is scoped by its workspace path, not by its global id', () => {
        const inside = makeSession('g-agent-in', 'copilot', { workspaceId: 'copilot-agent', workspacePath: SELLING });
        const outside = makeSession('g-agent-out', 'copilot', { workspaceId: 'copilot-agent', workspacePath: CHATWIZARD });
        assert.strictEqual(isSessionInScope(inside, ['ws-selling'], [SELLING]), true);
        assert.strictEqual(isSessionInScope(outside, ['ws-selling'], [SELLING]), false);
    });

    test('id-scoped sources are out of scope when nothing is selected', () => {
        const s = makeSession('cp3', 'copilot', { workspaceId: 'ws-any' });
        assert.strictEqual(isSessionInScope(s, [], [SELLING]), false);
    });
});

// ---------------------------------------------------------------------------
// isSessionInScope — sources that cannot be scoped
// ---------------------------------------------------------------------------

suite('isSessionInScope — unscoped sources', () => {

    const unscoped: SessionSource[] = ['antigravity', 'continue', 'amazonq', 'geminiCodeAssist', 'tabnine', 'zed'];

    for (const source of unscoped) {
        test(`${source}: always passes (machine-global store, cannot be scoped)`, () => {
            const s = makeSession(`u-${source}`, source);
            assert.strictEqual(isSessionInScope(s, ['ws-selling'], [SELLING]), true);
        });
    }
});

// ---------------------------------------------------------------------------
// Consistency: the single-session rule must not keep what the batch rule drops
// ---------------------------------------------------------------------------

suite('scope rule consistency', () => {

    test('every session dropped by the batch filter is also out of scope for the live rule', () => {
        const selectedIds = ['hash-selling', 'c--repo-selling'];
        const openFolders = [SELLING];
        const sessions: Session[] = [
            makeSession('cline-in', 'cline', { workspacePath: path.join(SELLING, 'tasks', 't1') }),
            makeSession('cline-out', 'cline', { workspacePath: CHATWIZARD }),
            makeSession('roo-in', 'roocode', { workspacePath: SELLING }),
            makeSession('roo-out', 'roocode', { workspacePath: CHATWIZARD }),
            makeSession('aider-in', 'aider', { workspacePath: SELLING }),
            makeSession('aider-out', 'aider', { workspacePath: CHATWIZARD }),
            makeSession('copilot-in', 'copilot', { workspaceId: 'hash-selling' }),
            makeSession('copilot-out', 'copilot', { workspaceId: 'hash-other' }),
            makeSession('copilot-agent-in', 'copilot', { workspaceId: 'copilot-agent', workspacePath: path.join(SELLING, 'src') }),
            makeSession('copilot-agent-out', 'copilot', { workspaceId: 'copilot-agent', workspacePath: CHATWIZARD }),
            makeSession('claude-in', 'claude', { workspaceId: 'sid-1', filePath: claudeFilePath('c--repo-selling', 'sid-1') }),
            makeSession('claude-out', 'claude', { workspaceId: 'sid-2', filePath: claudeFilePath('c--repo-other', 'sid-2') }),
            makeSession('cursor-in', 'cursor', { workspaceId: 'hash-selling' }),
            makeSession('cursor-out', 'cursor', { workspaceId: 'hash-other' }),
            makeSession('cursor-global', 'cursor', { workspaceId: 'cursor-global' }),
            makeSession('windsurf-in', 'windsurf', { workspaceId: 'hash-selling' }),
            makeSession('windsurf-out', 'windsurf', { workspaceId: 'hash-other' }),
            makeSession('antigravity', 'antigravity'),
            makeSession('continue', 'continue'),
        ];

        const batchIds = new Set(
            filterSessionsByWorkspaceScope(sessions, selectedIds, openFolders).map(s => s.id)
        );
        const liveIds = new Set(
            sessions.filter(s => isSessionInScope(s, selectedIds, openFolders)).map(s => s.id)
        );

        // ID-scoped sources are filtered upstream by the batch collector (it never
        // sees the foreign ones), so the batch result is a superset. The invariant
        // that matters: nothing the batch rule drops may survive the live rule.
        const batchDropped = sessions.map(s => s.id).filter(id => !batchIds.has(id));
        for (const id of batchDropped) {
            assert.ok(!liveIds.has(id), `live rule must also drop '${id}'`);
        }

        const liveDropped = sessions.map(s => s.id).filter(id => !liveIds.has(id)).sort();
        assert.deepStrictEqual(liveDropped, [
            'aider-out',
            'claude-out',
            'cline-out',
            'copilot-agent-out',
            'copilot-out',
            'cursor-out',
            'roo-out',
            'windsurf-out',
        ]);
    });
});
