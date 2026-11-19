/**
 * test/unit/commandStatements.test.ts
 *
 * Commands view — the detail panel prints a one-line command sequence with one
 * statement per line. These tests pin the pure splitter's behaviour:
 *   - `;` / `&&` / `||` separate statements, physical newlines too
 *   - quotes, brackets and pipelines stay intact
 *   - separators are preserved by `formatCommandStatements` (copy-pasteable)
 *
 * No VS Code host is required.
 */

import * as assert from 'assert';
import {
    formatCommandStatements,
    splitCommandStatementParts,
    splitCommandStatements,
} from '../../src/logs/commandStatements';

suite('commandStatements — splitting', () => {
    test('a single statement is returned unchanged', () => {
        assert.deepStrictEqual(splitCommandStatements('npm test'), ['npm test']);
        assert.strictEqual(formatCommandStatements('npm test'), 'npm test');
        assert.strictEqual(formatCommandStatements('  npm test  '), 'npm test');
    });

    test('separates ; && and || chains', () => {
        assert.deepStrictEqual(
            splitCommandStatements('cd repo && npm install; npm test || echo failed'),
            ['cd repo', 'npm install', 'npm test', 'echo failed']
        );
    });

    test('physical newlines are separators too (CRLF normalized)', () => {
        assert.deepStrictEqual(
            splitCommandStatements('npm install\r\nnpm test\r\necho done'),
            ['npm install', 'npm test', 'echo done']
        );
        assert.deepStrictEqual(splitCommandStatements('\n\n  git status  \n\n'), ['git status']);
    });

    test('separators inside quotes or brackets do not split', () => {
        assert.deepStrictEqual(
            splitCommandStatements('git commit -m "fix: a; b && c"'),
            ['git commit -m "fix: a; b && c"']
        );
        assert.deepStrictEqual(
            splitCommandStatements("echo 'one || two'"),
            ["echo 'one || two'"]
        );
        assert.deepStrictEqual(
            splitCommandStatements('(Get-ChildItem; Get-Date) | Out-Null'),
            ['(Get-ChildItem; Get-Date) | Out-Null']
        );
    });

    test('escaped quotes do not open a string', () => {
        assert.deepStrictEqual(
            splitCommandStatements('echo "a \\"quoted; still one\\" b"; echo done'),
            ['echo "a \\"quoted; still one\\" b"', 'echo done']
        );
    });

    test('pipelines are one statement', () => {
        assert.deepStrictEqual(
            splitCommandStatements("Get-ChildItem -Recurse | Where-Object { $_.Name -like '*.ts' }"),
            ["Get-ChildItem -Recurse | Where-Object { $_.Name -like '*.ts' }"]
        );
    });

    test('compound statements are not broken apart', () => {
        assert.deepStrictEqual(
            splitCommandStatements('for f in a b; do echo $f; done'),
            ['for f in a b; do echo $f; done']
        );
    });

    test('statement parts carry the separator that followed them', () => {
        assert.deepStrictEqual(
            splitCommandStatementParts('npm run build && npm test; echo done'),
            [
                { text: 'npm run build', separator: '&&' },
                { text: 'npm test', separator: ';' },
                { text: 'echo done', separator: '' },
            ]
        );
    });

    test('empty input yields nothing', () => {
        assert.deepStrictEqual(splitCommandStatements(undefined), []);
        assert.deepStrictEqual(splitCommandStatements('   \n\t '), []);
        assert.strictEqual(formatCommandStatements(undefined), '');
    });
});

suite('commandStatements — formatting', () => {
    test('one statement per line, separators kept', () => {
        assert.strictEqual(
            formatCommandStatements('cd repo && npm install; npm test || echo failed'),
            'cd repo &&\nnpm install;\nnpm test ||\necho failed'
        );
    });

    test('a pipeline stays on one line', () => {
        assert.strictEqual(
            formatCommandStatements('rg TOKEN src | Select-Object -First 5'),
            'rg TOKEN src | Select-Object -First 5'
        );
    });

    test('already multi-line input is normalized, not duplicated', () => {
        assert.strictEqual(
            formatCommandStatements('npm install\nnpm test'),
            'npm install\nnpm test'
        );
    });
});
