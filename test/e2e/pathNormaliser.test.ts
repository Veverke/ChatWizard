// test/e2e/pathNormaliser.test.ts
import * as assert from 'assert';
import { normalisePath, isSamePath, sessionTouchesFile, sessionMentionsFile } from '../../src/utils/pathNormaliser';

suite('pathNormaliser', () => {

    suite('normalisePath', () => {

        test('converts backslashes to forward slashes', () => {
            const result = normalisePath('C:\\Users\\test\\file.ts');
            assert.ok(!result.includes('\\'));
        });

        test('lowercases the drive letter on Windows paths', () => {
            if (process.platform !== 'win32') { return; }   // drive letters only exist on Windows
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

    suite('sessionMentionsFile', () => {

        test('returns true on exact match', () => {
            const norm = normalisePath('/project/src/index.ts');
            assert.strictEqual(sessionMentionsFile([norm], norm), true);
        });

        test('returns true on suffix match for relative path', () => {
            const abs = normalisePath('/project/docs/intent.md');
            assert.strictEqual(sessionMentionsFile(['docs/intent.md'], abs), true);
        });

        test('returns true on basename match', () => {
            const abs = normalisePath('/project/docs/intent.md');
            assert.strictEqual(sessionMentionsFile(['intent.md'], abs), true);
        });

        test('returns false when no match', () => {
            const abs = normalisePath('/project/src/foo.ts');
            assert.strictEqual(sessionMentionsFile(['bar.ts', 'baz.ts'], abs), false);
        });

        test('returns false for undefined paths', () => {
            assert.strictEqual(sessionMentionsFile(undefined, normalisePath('/foo.ts')), false);
        });

    });

});
