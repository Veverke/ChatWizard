// test/suite/codeBlockSearch.test.ts

import * as assert from 'assert';
import { CodeBlockSearchEngine } from '../../src/codeblocks/codeBlockSearchEngine';
import { IndexedCodeBlock } from '../../src/types/index';

function makeBlock(
    content: string,
    language: string,
    sessionId = 'session-1',
    messageRole: 'user' | 'assistant' = 'assistant'
): IndexedCodeBlock {
    return {
        language,
        content,
        sessionId,
        messageIndex: 0,
        messageRole,
        sessionTitle: `Session ${sessionId}`,
        sessionSource: 'copilot',
        sessionUpdatedAt: '2024-06-01T00:00:00.000Z',
        sessionWorkspacePath: '/projects/test',
    };
}

suite('CodeBlockSearchEngine', () => {
    let engine: CodeBlockSearchEngine;

    setup(() => {
        engine = new CodeBlockSearchEngine();
    });

    // 1. Empty index
    test('empty index: search returns empty array', () => {
        engine.index([]);
        assert.deepStrictEqual(engine.search(''), []);
    });

    test('empty index: getLanguages returns empty array', () => {
        engine.index([]);
        assert.deepStrictEqual(engine.getLanguages(), []);
    });

    // 2. Single block indexed
    test('single block: empty query returns the block', () => {
        const block = makeBlock('console.log("hello")', 'javascript');
        engine.index([block]);
        const results = engine.search('');
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0], block);
    });

    // 3. Empty query returns all blocks
    test('empty query returns all indexed blocks', () => {
        const blocks = [
            makeBlock('const x = 1', 'typescript'),
            makeBlock('let y = 2',   'typescript'),
            makeBlock('x = 3',       'python'),
        ];
        engine.index(blocks);
        assert.strictEqual(engine.search('').length, 3);
    });

    // 4. Case-insensitive content match
    test('search is case-insensitive', () => {
        engine.index([makeBlock('Hello World function', 'javascript')]);
        assert.strictEqual(engine.search('hello').length, 1);
        assert.strictEqual(engine.search('WORLD').length, 1);
        assert.strictEqual(engine.search('Hello World').length, 1);
    });

    // 5. No match
    test('no-match query returns empty array', () => {
        engine.index([makeBlock('console.log("hello")', 'javascript')]);
        assert.deepStrictEqual(engine.search('xyzzy-not-here'), []);
    });

    // 6. Language filter
    test('language filter returns only matching language', () => {
        const ts1 = makeBlock('const foo = 1', 'typescript');
        const ts2 = makeBlock('const bar = 2', 'typescript');
        const py  = makeBlock('x = 3',         'python');
        engine.index([ts1, ts2, py]);

        const tsResults = engine.search('', 'typescript');
        assert.strictEqual(tsResults.length, 2);
        assert.ok(tsResults.every(b => b.language === 'typescript'));

        const pyResults = engine.search('', 'python');
        assert.strictEqual(pyResults.length, 1);
        assert.strictEqual(pyResults[0], py);
    });

    // 7. Combined query + language filter
    test('query and language filter are ANDed together', () => {
        const ts = makeBlock('function greet() {}', 'typescript');
        const py = makeBlock('def greet(): pass',   'python');
        engine.index([ts, py]);

        const results = engine.search('greet', 'typescript');
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0], ts);
    });

    // 8. getLanguages returns sorted unique labels
    test('getLanguages returns sorted unique language labels', () => {
        engine.index([
            makeBlock('code', 'typescript'),
            makeBlock('code', 'python'),
            makeBlock('code', 'typescript'),
            makeBlock('code', 'javascript'),
        ]);
        const langs = engine.getLanguages();
        assert.deepStrictEqual(langs, ['javascript', 'python', 'typescript']);
    });

    // 9. index() replaces previous content
    test('calling index() again replaces old blocks', () => {
        engine.index([makeBlock('old content', 'typescript')]);
        assert.strictEqual(engine.search('old').length, 1);

        engine.index([makeBlock('new content', 'python')]);
        assert.strictEqual(engine.search('old').length, 0);
        assert.strictEqual(engine.search('new').length, 1);
        assert.deepStrictEqual(engine.getLanguages(), ['python']);
    });

    // 10. Language filter is case-insensitive
    test('language filter is case-insensitive', () => {
        engine.index([makeBlock('const x = 1', 'TypeScript')]);
        assert.strictEqual(engine.search('', 'typescript').length, 1);
        assert.strictEqual(engine.search('', 'TYPESCRIPT').length, 1);
    });

    // 11. Empty string language filter means no filtering
    test('empty string language filter returns all blocks regardless of language', () => {
        engine.index([
            makeBlock('a', 'typescript'),
            makeBlock('b', 'python'),
        ]);
        assert.strictEqual(engine.search('', '').length, 2);
    });

    // 12. Insertion order preserved
    test('results preserve insertion order', () => {
        const b1 = makeBlock('first',  'js');
        const b2 = makeBlock('second', 'js');
        const b3 = makeBlock('third',  'js');
        engine.index([b1, b2, b3]);
        const results = engine.search('');
        assert.strictEqual(results[0], b1);
        assert.strictEqual(results[1], b2);
        assert.strictEqual(results[2], b3);
    });

    // 13. Query is substring, not whole-word
    test('query matches substrings, not just whole words', () => {
        engine.index([makeBlock('refactoring the code', 'typescript')]);
        // "factor" is a substring of "refactoring"
        assert.strictEqual(engine.search('factor').length, 1);
    });

    // 14. Blocks with empty language are included in getLanguages and searchable
    test('blocks with empty language are included in getLanguages and search', () => {
        engine.index([
            makeBlock('unlabeled code', ''),
            makeBlock('typed code', 'typescript'),
        ]);
        const langs = engine.getLanguages();
        assert.ok(langs.includes(''), 'expected empty string in languages');

        const results = engine.search('', '');
        assert.strictEqual(results.length, 2);
    });

    // 15. Result fields are present and correctly propagated
    test('result objects carry all expected metadata fields', () => {
        const block = makeBlock('const x = 1', 'typescript', 'session-42', 'user');
        engine.index([block]);
        const [result] = engine.search('');
        assert.strictEqual(result.sessionId, 'session-42');
        assert.strictEqual(result.messageRole, 'user');
        assert.strictEqual(result.sessionTitle, 'Session session-42');
        assert.strictEqual(result.sessionSource, 'copilot');
        assert.strictEqual(result.language, 'typescript');
        assert.strictEqual(result.content, 'const x = 1');
    });
});

