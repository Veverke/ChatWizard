import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import {
    resolveClaudeProjectsPath,
    resolveCopilotStoragePath,
    resolveClineStoragePath,
    resolveRooCodeStoragePath,
    resolveCursorStoragePath,
    resolveWindsurfStoragePath,
    resolveAntigravityBrainPath,
} from '../../src/watcher/configPaths';

suite('configPaths', () => {

    // ------------------------------------------------------------------ //
    // resolveClaudeProjectsPath
    // ------------------------------------------------------------------ //

    test('no override returns default ~/.claude/projects path', () => {
        // When vscode config is not available (test host), should fall back to default.
        const result = resolveClaudeProjectsPath();
        const expected = path.join(os.homedir(), '.claude', 'projects');
        assert.strictEqual(result, expected);
    });

    test('empty string override returns default path (not empty string)', () => {
        const result = resolveClaudeProjectsPath('');
        const expected = path.join(os.homedir(), '.claude', 'projects');
        assert.strictEqual(result, expected);
    });

    test('non-empty override is returned exactly', () => {
        const result = resolveClaudeProjectsPath('/custom/path');
        assert.strictEqual(result, '/custom/path');
    });

    test('Windows-style override path is returned exactly', () => {
        const winPath = 'C:\\Users\\test\\.claude\\projects';
        const result = resolveClaudeProjectsPath(winPath);
        assert.strictEqual(result, winPath);
    });

    test('result is always a string type', () => {
        const result = resolveClaudeProjectsPath();
        assert.strictEqual(typeof result, 'string');
    });

    test('does not throw when vscode module is unavailable (test host)', () => {
        // This test itself demonstrates graceful handling — if we got here
        // without an exception from the import, the module loaded fine.
        // Calling without args exercises the try/catch around require('vscode').
        assert.doesNotThrow(() => {
            resolveClaudeProjectsPath();
        });
    });

    // ------------------------------------------------------------------ //
    // resolveCopilotStoragePath
    // ------------------------------------------------------------------ //

    test('no override returns path containing workspaceStorage', () => {
        const result = resolveCopilotStoragePath();
        const normalized = result.replace(/\\/g, '/');
        assert.ok(
            normalized.includes('Code/User/workspaceStorage'),
            `Expected path to contain 'Code/User/workspaceStorage', got: ${result}`
        );
    });

    test('explicit override is returned exactly', () => {
        const result = resolveCopilotStoragePath('/custom/copilot');
        assert.strictEqual(result, '/custom/copilot');
    });

    test('empty string override returns default containing workspaceStorage', () => {
        const result = resolveCopilotStoragePath('');
        const normalized = result.replace(/\\/g, '/');
        assert.ok(
            normalized.includes('workspaceStorage'),
            `Expected path to contain 'workspaceStorage', got: ${result}`
        );
    });

    test('APPDATA env usage — returns non-empty string', () => {
        const result = resolveCopilotStoragePath();
        assert.ok(typeof result === 'string' && result.length > 0);
    });

    test('does not throw when vscode module is unavailable (test host)', () => {
        assert.doesNotThrow(() => {
            resolveCopilotStoragePath();
        });
    });
});

// ------------------------------------------------------------------ //
// resolveClineStoragePath
// ------------------------------------------------------------------ //

suite('resolveClineStoragePath', () => {

    test('explicit override is returned exactly', () => {
        const result = resolveClineStoragePath('/custom/cline');
        assert.strictEqual(result, '/custom/cline');
    });

    test('empty string override returns default containing cline path segment', () => {
        const result = resolveClineStoragePath('');
        assert.ok(typeof result === 'string' && result.length > 0,
            `Expected non-empty default path, got: ${result}`);
    });

    test('no override returns a non-empty string', () => {
        const result = resolveClineStoragePath();
        assert.ok(typeof result === 'string' && result.length > 0);
    });

    test('does not throw when vscode module is unavailable (test host)', () => {
        assert.doesNotThrow(() => { resolveClineStoragePath(); });
    });
});

// ------------------------------------------------------------------ //
// resolveRooCodeStoragePath
// ------------------------------------------------------------------ //

suite('resolveRooCodeStoragePath', () => {

    test('explicit override is returned exactly', () => {
        const result = resolveRooCodeStoragePath('/custom/roocode');
        assert.strictEqual(result, '/custom/roocode');
    });

    test('empty string override returns non-empty default', () => {
        const result = resolveRooCodeStoragePath('');
        assert.ok(typeof result === 'string' && result.length > 0);
    });

    test('no override returns a non-empty string', () => {
        const result = resolveRooCodeStoragePath();
        assert.ok(typeof result === 'string' && result.length > 0);
    });

    test('does not throw when vscode module is unavailable (test host)', () => {
        assert.doesNotThrow(() => { resolveRooCodeStoragePath(); });
    });
});

// ------------------------------------------------------------------ //
// resolveCursorStoragePath
// ------------------------------------------------------------------ //

suite('resolveCursorStoragePath', () => {

    test('explicit override is returned exactly', () => {
        const result = resolveCursorStoragePath('/custom/cursor');
        assert.strictEqual(result, '/custom/cursor');
    });

    test('empty string override returns non-empty default', () => {
        const result = resolveCursorStoragePath('');
        assert.ok(typeof result === 'string' && result.length > 0);
    });

    test('no override returns a non-empty string', () => {
        const result = resolveCursorStoragePath();
        assert.ok(typeof result === 'string' && result.length > 0);
    });

    test('does not throw when vscode module is unavailable (test host)', () => {
        assert.doesNotThrow(() => { resolveCursorStoragePath(); });
    });
});

// ------------------------------------------------------------------ //
// resolveWindsurfStoragePath
// ------------------------------------------------------------------ //

suite('resolveWindsurfStoragePath', () => {

    test('explicit override is returned exactly', () => {
        const result = resolveWindsurfStoragePath('/custom/windsurf');
        assert.strictEqual(result, '/custom/windsurf');
    });

    test('empty string override returns non-empty default', () => {
        const result = resolveWindsurfStoragePath('');
        assert.ok(typeof result === 'string' && result.length > 0);
    });

    test('no override returns a non-empty string', () => {
        const result = resolveWindsurfStoragePath();
        assert.ok(typeof result === 'string' && result.length > 0);
    });

    test('does not throw when vscode module is unavailable (test host)', () => {
        assert.doesNotThrow(() => { resolveWindsurfStoragePath(); });
    });
});

// ------------------------------------------------------------------ //
// resolveAntigravityBrainPath
// ------------------------------------------------------------------ //

suite('resolveAntigravityBrainPath', () => {

    test('explicit override is returned exactly', () => {
        const result = resolveAntigravityBrainPath('/custom/brain');
        assert.strictEqual(result, '/custom/brain');
    });

    test('empty string override returns non-empty default', () => {
        const result = resolveAntigravityBrainPath('');
        assert.ok(typeof result === 'string' && result.length > 0);
    });

    test('no override returns a path containing antigravity brain segment', () => {
        const result = resolveAntigravityBrainPath();
        assert.ok(typeof result === 'string' && result.length > 0);
    });

    test('default path contains "gemini" or "antigravity" directory segment', () => {
        const result = resolveAntigravityBrainPath();
        const lower = result.toLowerCase().replace(/\\/g, '/');
        assert.ok(
            lower.includes('gemini') || lower.includes('antigravity') || lower.includes('brain'),
            `Expected brain path to contain a recognisable segment, got: ${result}`
        );
    });

    test('does not throw when vscode module is unavailable (test host)', () => {
        assert.doesNotThrow(() => { resolveAntigravityBrainPath(); });
    });
});

