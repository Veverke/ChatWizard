// test/e2e/entityExtractor.test.ts
import * as assert from 'assert';
import { extractEntities } from '../../src/analytics/entityExtractor';
import { Session } from '../../src/types/index';

function makeSession(content: string): Session {
    return {
        id: 'test-id',
        title: 'Test',
        source: 'copilot',
        date: new Date().toISOString(),
        messages: [{ role: 'user', content, timestamp: '', codeBlocks: [] }],
        workspace: '',
        model: '',
        totalTokens: 0,
    } as unknown as Session;
}

suite('entityExtractor', () => {

    test('extracts file paths', () => {
        const session = makeSession('I edited src/utils/helper.ts and src/extension.ts');
        const result = extractEntities(session);
        assert.ok(result.filePaths.length > 0);
        assert.ok(result.filePaths.some(f => f.includes('helper.ts')));
    });

    test('extracts GitHub-style issue references', () => {
        const session = makeSession('Fixed issue #42 and PR #99');
        const result = extractEntities(session);
        assert.ok(Array.isArray(result.decisions));
    });

    test('returns empty arrays on plain text', () => {
        const session = makeSession('Hello world, nothing special here.');
        const result = extractEntities(session);
        assert.ok(Array.isArray(result.filePaths));
        assert.ok(Array.isArray(result.functionNames));
        assert.ok(Array.isArray(result.errors));
    });

    test('extracts error mentions', () => {
        const session = makeSession('Got TypeError: Cannot read property foo of undefined');
        const result = extractEntities(session);
        assert.ok(Array.isArray(result.errors));
        assert.ok(result.errors.some(e => e.toLowerCase().includes('typeerror')));
    });

});
