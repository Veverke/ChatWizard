import * as assert from 'assert';
import { CodeBlockSearchEngine } from '../../src/codeblocks/codeBlockSearchEngine';
import { IndexedCodeBlock } from '../../src/types/index';

function makeBlock(sessionId: string, content: string, language: string): IndexedCodeBlock {
    return {
        sessionId,
        content,
        language,
        messageIndex: 0,
        messageRole: 'assistant',
        sessionTitle: '',
        sessionSource: 'claude',
        sessionUpdatedAt: '',
        sessionWorkspacePath: undefined,
    };
}

suite('CodeBlockSearchEngine — incremental updates', () => {

    // ------------------------------------------------------------------ size
    suite('size', () => {
        test('empty engine returns 0', () => {
            const engine = new CodeBlockSearchEngine();
            assert.strictEqual(engine.size, 0);
        });

        test('after index([b1, b2]) returns 2', () => {
            const engine = new CodeBlockSearchEngine();
            engine.index([makeBlock('s1', 'foo', 'ts'), makeBlock('s2', 'bar', 'js')]);
            assert.strictEqual(engine.size, 2);
        });

        test('after upsertBySession with 3 blocks returns 3', () => {
            const engine = new CodeBlockSearchEngine();
            engine.upsertBySession('s1', [
                makeBlock('s1', 'a', 'ts'),
                makeBlock('s1', 'b', 'ts'),
                makeBlock('s1', 'c', 'ts'),
            ]);
            assert.strictEqual(engine.size, 3);
        });

        test('after removeBySession returns 0 for that session', () => {
            const engine = new CodeBlockSearchEngine();
            engine.index([makeBlock('s1', 'foo', 'ts'), makeBlock('s1', 'bar', 'ts')]);
            engine.removeBySession('s1');
            assert.strictEqual(engine.size, 0);
        });
    });

    // ------------------------------------------------------- removeBySession
    suite('removeBySession', () => {
        test('no error thrown on empty engine', () => {
            const engine = new CodeBlockSearchEngine();
            assert.doesNotThrow(() => engine.removeBySession('nonexistent'));
        });

        test('no error and size unchanged for unknown id', () => {
            const engine = new CodeBlockSearchEngine();
            engine.index([makeBlock('s1', 'hello', 'py')]);
            assert.doesNotThrow(() => engine.removeBySession('unknown-id'));
            assert.strictEqual(engine.size, 1);
        });

        test('removes correct session only', () => {
            const engine = new CodeBlockSearchEngine();
            const blockA = makeBlock('sessionA', 'content-alpha', 'ts');
            const blockB1 = makeBlock('sessionB', 'content-beta-1', 'js');
            const blockB2 = makeBlock('sessionB', 'content-beta-2', 'js');
            engine.index([blockA, blockB1, blockB2]);

            engine.removeBySession('sessionA');

            // A's block is gone
            assert.strictEqual(engine.search('content-alpha').length, 0);
            // B's blocks remain
            assert.strictEqual(engine.search('content-beta-1').length, 1);
            assert.strictEqual(engine.search('content-beta-2').length, 1);
            // size reflects only B's blocks
            assert.strictEqual(engine.size, 2);
        });
    });

    // ------------------------------------------------------- upsertBySession
    suite('upsertBySession', () => {
        test('on empty engine adds blocks and makes them searchable', () => {
            const engine = new CodeBlockSearchEngine();
            engine.upsertBySession('s1', [
                makeBlock('s1', 'hello world', 'ts'),
                makeBlock('s1', 'goodbye world', 'ts'),
            ]);
            assert.strictEqual(engine.size, 2);
            assert.strictEqual(engine.search('hello').length, 1);
            assert.strictEqual(engine.search('goodbye').length, 1);
        });

        test('replaces existing blocks for session', () => {
            const engine = new CodeBlockSearchEngine();
            engine.index([makeBlock('s1', 'old-content', 'ts')]);

            engine.upsertBySession('s1', [
                makeBlock('s1', 'new-content-A', 'ts'),
                makeBlock('s1', 'new-content-B', 'ts'),
            ]);

            // old content gone
            assert.strictEqual(engine.search('old-content').length, 0);
            // new content present
            assert.strictEqual(engine.search('new-content-A').length, 1);
            assert.strictEqual(engine.search('new-content-B').length, 1);
            assert.strictEqual(engine.size, 2);
        });

        test('idempotent — calling twice with same data yields same result', () => {
            const engine = new CodeBlockSearchEngine();
            const blocks = [
                makeBlock('s1', 'alpha', 'ts'),
                makeBlock('s1', 'beta', 'ts'),
            ];

            engine.upsertBySession('s1', blocks);
            engine.upsertBySession('s1', blocks);

            assert.strictEqual(engine.size, 2);
            assert.strictEqual(engine.search('alpha').length, 1);
            assert.strictEqual(engine.search('beta').length, 1);
        });

        test('preserves other sessions when upserting one session', () => {
            const engine = new CodeBlockSearchEngine();
            engine.index([
                makeBlock('sessionA', 'content-a', 'ts'),
                makeBlock('sessionB', 'content-b', 'js'),
            ]);

            engine.upsertBySession('sessionB', [makeBlock('sessionB', 'content-b-updated', 'js')]);

            // Session A untouched
            assert.strictEqual(engine.search('content-a').length, 1);
            // Session B updated
            assert.strictEqual(engine.search('content-b-updated').length, 1);
            assert.strictEqual(engine.search('content-b').length, 1); // 'content-b' is a substring of 'content-b-updated'
            assert.strictEqual(engine.size, 2);
        });

        test('with empty array behaves like removeBySession', () => {
            const engine = new CodeBlockSearchEngine();
            engine.index([
                makeBlock('s1', 'remove-me', 'ts'),
                makeBlock('s2', 'keep-me', 'ts'),
            ]);

            engine.upsertBySession('s1', []);

            assert.strictEqual(engine.search('remove-me').length, 0);
            assert.strictEqual(engine.search('keep-me').length, 1);
            assert.strictEqual(engine.size, 1);
        });
    });

    // ------------------------------------------------------- getLanguages
    suite('getLanguages after incremental updates', () => {
        test('new language appears after upsertBySession', () => {
            const engine = new CodeBlockSearchEngine();
            engine.index([makeBlock('s1', 'foo', 'ts')]);
            engine.upsertBySession('s2', [makeBlock('s2', 'bar', 'rust')]);

            const langs = engine.getLanguages();
            assert.ok(langs.includes('rust'), 'rust should be present');
            assert.ok(langs.includes('ts'), 'ts should still be present');
        });

        test("removed session's language disappears when no other session has it", () => {
            const engine = new CodeBlockSearchEngine();
            engine.index([
                makeBlock('s1', 'foo', 'ts'),
                makeBlock('s2', 'bar', 'uniqueLang'),
            ]);

            engine.removeBySession('s2');

            const langs = engine.getLanguages();
            assert.ok(!langs.includes('uniqueLang'), 'uniqueLang should be removed');
            assert.ok(langs.includes('ts'), 'ts should remain');
        });

        test("language remains if another session still has it after removal", () => {
            const engine = new CodeBlockSearchEngine();
            engine.index([
                makeBlock('s1', 'foo', 'ts'),
                makeBlock('s2', 'bar', 'ts'),
            ]);

            engine.removeBySession('s1');

            const langs = engine.getLanguages();
            assert.ok(langs.includes('ts'), 'ts should remain since s2 still has it');
        });
    });

    // ------------------------------------------------------- search integration
    suite('search after incremental updates', () => {
        test('removed session content not found in search', () => {
            const engine = new CodeBlockSearchEngine();
            engine.index([
                makeBlock('s1', 'find-this', 'ts'),
                makeBlock('s2', 'also-here', 'ts'),
            ]);

            engine.removeBySession('s1');

            assert.strictEqual(engine.search('find-this').length, 0);
            assert.strictEqual(engine.search('also-here').length, 1);
        });

        test('new content is searchable and old content no longer matches after upsert', () => {
            const engine = new CodeBlockSearchEngine();
            engine.index([makeBlock('s1', 'stale-content', 'ts')]);

            engine.upsertBySession('s1', [makeBlock('s1', 'fresh-content', 'ts')]);

            assert.strictEqual(engine.search('stale-content').length, 0);
            assert.strictEqual(engine.search('fresh-content').length, 1);
        });
    });
});
