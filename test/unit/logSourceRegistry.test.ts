/**
 * test/unit/logSourceRegistry.test.ts
 *
 * Unit tests for Phase 1 — LogSourceRegistry (watch-logs source registry).
 */

import * as assert from 'assert';
import { LogSourceRegistry, createDefaultLogSourceRegistry } from '../../src/logs/logSourceRegistry';
import { LogSourceTool } from '../../src/logs/types';

suite('LogSourceRegistry – watch-logs source registry', () => {
    test('register / get / all / tools round-trip', () => {
        const registry = new LogSourceRegistry();
        registry.register({
            tool: 'cursor',
            displayName: 'Cursor',
            format: 'sqlite',
            filePatterns: ['**/state.vscdb'],
            logRoots: ['/roots/cursor'],
            enabledSettingKey: 'chatwizard.indexCursor',
        });

        assert.ok(registry.get('cursor'), 'get() should return the config');
        assert.strictEqual(registry.all().length, 1);
        assert.deepStrictEqual(registry.tools(), ['cursor']);
        assert.strictEqual(registry.get('cline'), undefined);
    });

    test('register replaces an existing config for the same tool', () => {
        const registry = new LogSourceRegistry();
        registry.register({ ...stubSource('cursor'), displayName: 'Cursor A' });
        registry.register({ ...stubSource('cursor'), displayName: 'Cursor B' });

        assert.strictEqual(registry.all().length, 1);
        assert.strictEqual(registry.get('cursor')?.displayName, 'Cursor B');
    });

    test('createDefaultLogSourceRegistry registers the plan targets + GitHub Copilot (Phase 2)', () => {
        const registry = createDefaultLogSourceRegistry();
        const tools = registry.tools().sort();

        assert.deepStrictEqual(tools, ['aider', 'antigravity', 'cline', 'copilot', 'cursor', 'roocode', 'windsurf']);
        for (const cfg of registry.all()) {
            assert.ok(cfg.tool, 'tool id present');
            assert.ok(cfg.displayName.length > 0, 'displayName present');
            assert.ok(cfg.enabledSettingKey.startsWith('chatwizard.'), 'setting key is chatwizard.*');
            assert.ok(cfg.filePatterns.length > 0, 'filePatterns present');
        }
    });

    test('enabled() includes every source when settings unreadable', () => {
        const registry = createDefaultLogSourceRegistry();
        // In the unit-test extension host the chatwizard.* settings are at their
        // defaults (true); outside the host isEnabled() defaults to true too.
        assert.strictEqual(registry.enabled().length, registry.all().length);
    });

    test('resolveLogRoot returns default roots for fixed-root sources', () => {
        const registry = createDefaultLogSourceRegistry();
        for (const tool of ['cursor', 'cline', 'roocode', 'windsurf', 'antigravity'] as LogSourceTool[]) {
            const root = registry.resolveLogRoot(tool);
            assert.ok(root && root.length > 0, `${tool} should have a default log root`);
        }
    });

    test('resolveLogRoot returns undefined for project-local sources (aider)', () => {
        const registry = createDefaultLogSourceRegistry();
        assert.strictEqual(registry.resolveLogRoot('aider'), undefined);
    });

    test('resolveLogRoot returns undefined for unknown tools', () => {
        const registry = new LogSourceRegistry();
        assert.strictEqual(registry.resolveLogRoot('cursor'), undefined);
    });
});

/** Small source stub for registry behaviour tests. */
function stubSource(tool: LogSourceTool) {
    return {
        tool,
        displayName: tool,
        format: 'json' as const,
        filePatterns: ['**/*.json'],
        logRoots: ['/roots'],
        enabledSettingKey: `chatwizard.index${tool[0].toUpperCase()}${tool.slice(1)}`,
    };
}