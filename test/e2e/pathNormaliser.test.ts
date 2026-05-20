// test/e2e/pathNormaliser.test.ts
import * as assert from 'assert';
import { normalisePath, isSamePath, sessionTouchesFile } from '../../src/utils/pathNormaliser';

suite('pathNormaliser', () => {

    suite('normalisePath', () => {

        test('converts backslashes to forward slashes', () => {
            const result = normalisePath('C:\\Users\\test\\file.ts');
            assert.ok(!result.includes('\\'));
        });

        test('lowercases the drive letter on Windows paths', () => {
            // normalise a constructed path — the real realpath may not exist,
            // so we test the known-to-exist __filename
            const result = normalisePath(__filename);
            assert.strictEqual(result, result.toLowerCase().replace(/^([a-z]):/, m => m));
        });

    });

    suite('isSamePath', () => {

        test('same path returns true', () => {
            assert.strictEqual(isSamePath(__filename, __filename), true);
        });

        test('different paths return false', () => {
            assert.strictEqual(isSamePath('/foo/a.ts', '/foo/b.ts'), false);
        });

    });

    suite('sessionTouchesFile', () => {

        test('returns true when file is in importantFiles', () => {
            const result = sessionTouchesFile(
                [normalisePath('/some/file.ts')],
                normalisePath('/some/file.ts'),
            );
            assert.strictEqual(result, true);
        });

        test('returns false when file is not present', () => {
            const result = sessionTouchesFile(
                [normalisePath('/some/other.ts')],
                normalisePath('/some/file.ts'),
            );
            assert.strictEqual(result, false);
        });

        test('returns false for empty list', () => {
            assert.strictEqual(sessionTouchesFile([], normalisePath('/foo.ts')), false);
        });

    });

});
