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
            const result = normalisePath(__filename);
            // normalisePath lowercases the drive letter (e.g. C:/ → c:/) but not the rest
            assert.match(result, /^[a-z]:\//, 'Drive letter should be normalised to lowercase');
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
