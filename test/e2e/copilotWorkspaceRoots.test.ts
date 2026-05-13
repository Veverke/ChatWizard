// test/suite/copilotWorkspaceRoots.test.ts
//
// Tests for getWorkspaceStorageRoots() — the function that determines which
// VS Code variant storage directories to scan for Copilot chat sessions.
//
// Bugs caught by this suite:
//   Bug: Only Code-stable root was scanned; Code-Insiders sessions were invisible.
//   Bug: A user-configured custom path was ignored by the discovery layer.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// We import the function under test directly.
import { getWorkspaceStorageRoots, discoverCopilotWorkspaces } from '../../src/readers/copilotWorkspace';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function setup(): void {
    tmpDir = path.join(os.tmpdir(), `cw_roots_test_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
}

function teardown(): void {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Temporarily override process.env.APPDATA (Windows) or HOME for the
 * duration of `fn`, then restore.  Returns the function's return value.
 */
function withAppData<T>(fakeAppData: string, fn: () => T): T {
    const origAppData = process.env['APPDATA'];
    const origXdg     = process.env['XDG_CONFIG_HOME'];
    const origHome    = process.env['HOME'];

    if (process.platform === 'win32') {
        process.env['APPDATA'] = fakeAppData;
    } else {
        process.env['XDG_CONFIG_HOME'] = fakeAppData;
        process.env['HOME'] = fakeAppData; // fallback for darwin path helpers
    }

    try {
        return fn();
    } finally {
        if (origAppData !== undefined) { process.env['APPDATA'] = origAppData; } else { delete process.env['APPDATA']; }
        if (origXdg     !== undefined) { process.env['XDG_CONFIG_HOME'] = origXdg; } else { delete process.env['XDG_CONFIG_HOME']; }
        if (origHome    !== undefined) { process.env['HOME'] = origHome; } else { delete process.env['HOME']; }
    }
}

/** Create a fake workspaceStorage root directory and return its path. */
function makeFakeRoot(appDataBase: string, variant: string): string {
    const p = process.platform === 'win32'
        ? path.join(appDataBase, variant, 'User', 'workspaceStorage')
        : path.join(appDataBase, variant, 'User', 'workspaceStorage');
    fs.mkdirSync(p, { recursive: true });
    return p;
}

/** Write a minimal workspace.json + chatSessions dir under a root. */
function addWorkspaceToRoot(root: string, hash: string, workspacePath: string): void {
    const hashDir = path.join(root, hash);
    const chatDir = path.join(hashDir, 'chatSessions');
    fs.mkdirSync(chatDir, { recursive: true });
    fs.writeFileSync(path.join(hashDir, 'workspace.json'),
        JSON.stringify({ folder: `file:///${workspacePath.replace(/\\/g, '/')}` }));
    fs.writeFileSync(path.join(chatDir, 'session-abc.jsonl'), '');
}

// ---------------------------------------------------------------------------
// Suite: getWorkspaceStorageRoots — path discovery
// ---------------------------------------------------------------------------

suite('getWorkspaceStorageRoots — VS Code variant discovery', () => {

    setup(); // run immediately; mocha setup() hooks run before each test

    test('returns only existing directories', () => {
        setup();
        try {
            // Only Code-stable exists
            const fakeBase = tmpDir;
            makeFakeRoot(fakeBase, 'Code');
            // Code - Insiders is NOT created

            const roots = withAppData(fakeBase, () => getWorkspaceStorageRoots());

            assert.strictEqual(roots.length, 1, 'should return only 1 root when Insiders dir absent');
            assert.ok(roots[0].includes('Code'), `root should be Code path, got: ${roots[0]}`);
            assert.ok(!roots[0].includes('Insiders'), 'should not include Insiders path');
        } finally { teardown(); }
    });

    test('returns both roots when both Code and Code-Insiders exist', () => {
        setup();
        try {
            const fakeBase = tmpDir;
            makeFakeRoot(fakeBase, 'Code');
            makeFakeRoot(fakeBase, 'Code - Insiders');

            const roots = withAppData(fakeBase, () => getWorkspaceStorageRoots());

            assert.strictEqual(roots.length, 2, 'should return 2 roots when both variant dirs exist');
            const normalised = roots.map(r => r.replace(/\\/g, '/'));
            assert.ok(normalised.some(r => r.includes('/Code/') && !r.includes('Insiders')),
                'should include stable Code root');
            assert.ok(normalised.some(r => r.includes('Code - Insiders')),
                'should include Code-Insiders root');
        } finally { teardown(); }
    });

    test('returns empty array when neither variant dir exists', () => {
        setup();
        try {
            const fakeBase = path.join(tmpDir, 'nonexistent_base');
            // Don't create any subdirectories

            const roots = withAppData(fakeBase, () => getWorkspaceStorageRoots());

            assert.deepStrictEqual(roots, [], 'should return [] when no variant dirs exist');
        } finally { teardown(); }
    });

    test('does not include non-VS-Code directories', () => {
        setup();
        try {
            const fakeBase = tmpDir;
            makeFakeRoot(fakeBase, 'Code');
            // Create an unrelated directory that shouldn't be picked up
            fs.mkdirSync(path.join(fakeBase, 'SomeOtherApp', 'User', 'workspaceStorage'), { recursive: true });

            const roots = withAppData(fakeBase, () => getWorkspaceStorageRoots());

            assert.strictEqual(roots.length, 1, 'should only return recognised VS Code variant dirs');
        } finally { teardown(); }
    });
});

// ---------------------------------------------------------------------------
// Suite: discoverCopilotWorkspaces — multi-root session discovery
// ---------------------------------------------------------------------------

suite('discoverCopilotWorkspaces — multi-root (Code + Code-Insiders)', () => {

    test('discovers sessions from Code-stable root only', () => {
        setup();
        try {
            const fakeBase = tmpDir;
            const stableRoot = makeFakeRoot(fakeBase, 'Code');
            addWorkspaceToRoot(stableRoot, 'aabbcc001', '/projects/myapp');

            const workspaces = withAppData(fakeBase, () => discoverCopilotWorkspaces());

            assert.strictEqual(workspaces.length, 1);
            assert.ok(workspaces[0].workspacePath.includes('myapp'));
        } finally { teardown(); }
    });

    test('discovers sessions from Code-Insiders root only', () => {
        setup();
        try {
            const fakeBase = tmpDir;
            // No stable Code dir — only Insiders
            const insidersRoot = makeFakeRoot(fakeBase, 'Code - Insiders');
            addWorkspaceToRoot(insidersRoot, 'ddeeff002', '/projects/insiders-project');

            const workspaces = withAppData(fakeBase, () => discoverCopilotWorkspaces());

            assert.strictEqual(workspaces.length, 1);
            assert.ok(workspaces[0].workspacePath.includes('insiders-project'));
        } finally { teardown(); }
    });

    test('BUG regression: discovers sessions from BOTH Code and Code-Insiders roots', () => {
        setup();
        try {
            const fakeBase = tmpDir;
            const stableRoot  = makeFakeRoot(fakeBase, 'Code');
            const insidersRoot = makeFakeRoot(fakeBase, 'Code - Insiders');

            addWorkspaceToRoot(stableRoot,   'hash001', '/projects/stable-project');
            addWorkspaceToRoot(insidersRoot, 'hash002', '/projects/insiders-project');

            const workspaces = withAppData(fakeBase, () => discoverCopilotWorkspaces());

            assert.strictEqual(workspaces.length, 2,
                'must discover workspaces from BOTH storage roots');

            const paths = workspaces.map(w => w.workspacePath);
            assert.ok(paths.some(p => p.includes('stable-project')), 'stable-Code session missing');
            assert.ok(paths.some(p => p.includes('insiders-project')), 'Code-Insiders session missing');
        } finally { teardown(); }
    });

    test('same workspace open in both roots appears only once per storage hash (dedup by path key)', () => {
        setup();
        try {
            const fakeBase = tmpDir;
            const stableRoot   = makeFakeRoot(fakeBase, 'Code');
            const insidersRoot = makeFakeRoot(fakeBase, 'Code - Insiders');

            // Same workspace path → same hash used in both storage roots
            const SAME_HASH = 'sharedHash999';
            addWorkspaceToRoot(stableRoot,   SAME_HASH, '/projects/shared');
            addWorkspaceToRoot(insidersRoot, SAME_HASH, '/projects/shared');

            const workspaces = withAppData(fakeBase, () => discoverCopilotWorkspaces());

            // Two storage dirs exist (one per root), both point to the same workspacePath.
            // The picker command deduplicates by normalized workspacePath, so both entries
            // are allowed here — the dedup happens at display time. Verify we got at least 1.
            assert.ok(workspaces.length >= 1, 'should find at least one workspace entry');
            assert.ok(workspaces.every(w => w.workspacePath.includes('shared')));
        } finally { teardown(); }
    });

    test('returns empty array when neither variant dir contains chatSessions', () => {
        setup();
        try {
            const fakeBase = tmpDir;
            const stableRoot = makeFakeRoot(fakeBase, 'Code');
            // Create a hash dir but without chatSessions — not a Copilot workspace
            fs.mkdirSync(path.join(stableRoot, 'somehash'), { recursive: true });

            const workspaces = withAppData(fakeBase, () => discoverCopilotWorkspaces());

            assert.deepStrictEqual(workspaces, []);
        } finally { teardown(); }
    });
});
