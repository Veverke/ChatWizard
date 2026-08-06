/**
 * test/unit/chronicle.test.ts
 *
 * Unit tests for chronicle.ts — pure parser functions.
 * The actual SQLite I/O is tested via e2e tests with a real DB file.
 */

import * as assert from 'assert';
import { parseImportantFiles } from '../../src/parsers/chronicle';

suite('chronicle', () => {
    suite('parseImportantFiles', () => {
        test('parses JSON array format', () => {
            const result = parseImportantFiles('["src/main.ts","src/utils/helper.ts"]');
            assert.deepStrictEqual(result, ['src/main.ts', 'src/utils/helper.ts']);
        });

        test('returns undefined for null input', () => {
            assert.strictEqual(parseImportantFiles(null), undefined);
        });

        test('returns undefined for empty string', () => {
            assert.strictEqual(parseImportantFiles(''), undefined);
        });

        test('returns undefined for whitespace-only string', () => {
            assert.strictEqual(parseImportantFiles('   '), undefined);
        });

        test('filters out non-string entries from JSON array', () => {
            const result = parseImportantFiles('["file.ts", 42, null, false]');
            assert.deepStrictEqual(result, ['file.ts']);
        });

        test('filters out empty strings from JSON array', () => {
            const result = parseImportantFiles('["file.ts", ""]');
            assert.deepStrictEqual(result, ['file.ts']);
        });

        test('falls back to comma-separated for non-JSON string', () => {
            const result = parseImportantFiles('file1.ts,file2.ts,file3.ts');
            assert.deepStrictEqual(result, ['file1.ts', 'file2.ts', 'file3.ts']);
        });

        test('falls back to newline-separated for multi-line string', () => {
            const result = parseImportantFiles('file1.ts\nfile2.ts\nfile3.ts');
            assert.deepStrictEqual(result, ['file1.ts', 'file2.ts', 'file3.ts']);
        });

        test('trims whitespace in fallback parsing', () => {
            const result = parseImportantFiles('  file1.ts , file2.ts  ');
            assert.deepStrictEqual(result, ['file1.ts', 'file2.ts']);
        });

        test('returns undefined when JSON array contains only empty strings', () => {
            const result = parseImportantFiles('[""]');
            assert.strictEqual(result, undefined);
        });
    });
});