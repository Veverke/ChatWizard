/**
 * test/unit/sourceBrandIcons.test.ts
 *
 * Unit tests for sourceBrandIcons — pure function determining icon URIs per source.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { sourceBrandIconUris } from '../../src/ui/sourceBrandIcons';
import type { SessionSource } from '../../src/types/index';

suite('sourceBrandIcons', () => {
    const extensionUri = vscode.Uri.file('/test/extension');

    test('returns icon URIs for cline', () => {
        const result = sourceBrandIconUris('cline' as SessionSource, extensionUri);
        assert.ok(result, 'Expected non-null result for cline');
        assert.ok(result!.light.path.endsWith('cline_light.svg'), result!.light.path);
        assert.ok(result!.dark.path.endsWith('cline_dark.svg'), result!.dark.path);
    });

    test('returns icon URIs for roocode', () => {
        const result = sourceBrandIconUris('roocode' as SessionSource, extensionUri);
        assert.ok(result, 'Expected non-null result for roocode');
        assert.ok(result!.light.path.endsWith('roocode_light.svg'));
        assert.ok(result!.dark.path.endsWith('roocode_dark.svg'));
    });

    test('returns icon URIs for cursor', () => {
        const result = sourceBrandIconUris('cursor' as SessionSource, extensionUri);
        assert.ok(result, 'Expected non-null result for cursor');
        assert.ok(result!.light.path.endsWith('cursor_light.svg'));
    });

    test('returns icon URIs for windsurf', () => {
        const result = sourceBrandIconUris('windsurf' as SessionSource, extensionUri);
        assert.ok(result, 'Expected non-null result for windsurf');
    });

    test('returns icon URIs for aider', () => {
        const result = sourceBrandIconUris('aider' as SessionSource, extensionUri);
        assert.ok(result, 'Expected non-null result for aider');
    });

    test('returns icon URIs for antigravity', () => {
        const result = sourceBrandIconUris('antigravity' as SessionSource, extensionUri);
        assert.ok(result, 'Expected non-null result for antigravity');
    });

    test('returns null for copilot (codicon source)', () => {
        const result = sourceBrandIconUris('copilot' as SessionSource, extensionUri);
        assert.strictEqual(result, null);
    });

    test('returns null for claude (codicon source)', () => {
        const result = sourceBrandIconUris('claude' as SessionSource, extensionUri);
        assert.strictEqual(result, null);
    });

    test('returns null for unknown source', () => {
        const result = sourceBrandIconUris('unknown' as SessionSource, extensionUri);
        assert.strictEqual(result, null);
    });
});