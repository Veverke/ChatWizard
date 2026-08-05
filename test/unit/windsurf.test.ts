/**
 * test/unit/windsurf.test.ts
 *
 * Unit tests for windsurf.ts parser — focuses on edge cases not covered by e2e tests.
 * Tests avoid SQLite I/O by mocking the cascade session data JSON.
 */

import * as assert from 'assert';
import { extractWindsurfCodeBlocks } from '../../src/parsers/windsurf';

suite('windsurf (unit)', () => {
    suite('extractWindsurfCodeBlocks', () => {
        test('returns empty array for content with no code fences', () => {
            const blocks = extractWindsurfCodeBlocks('plain text', 'session-1', 0);
            assert.strictEqual(blocks.length, 0);
        });

        test('extracts code blocks from fenced content', () => {
            const content = '```python\nprint("hello")\n```';
            const blocks = extractWindsurfCodeBlocks(content, 'session-1', 1);
            assert.strictEqual(blocks.length, 1);
            assert.strictEqual(blocks[0].language, 'python');
            assert.strictEqual(blocks[0].content, 'print("hello")');
        });
    });
});