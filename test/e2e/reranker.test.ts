// test/e2e/reranker.test.ts
import * as assert from 'assert';
import { TfIdfReranker } from '../../src/search/reranker';
import { Session } from '../../src/types/index';

function makeCandidate(id: string, title: string): { id: string; session: Session } {
    return {
        id,
        session: {
            id,
            title,
            source: 'copilot',
            date: new Date().toISOString(),
            messages: [],
            workspace: '',
            model: '',
            totalTokens: 0,
        } as unknown as Session,
    };
}

suite('TfIdfReranker', () => {

    const reranker = new TfIdfReranker();

    test('returns same number of results', () => {
        const candidates = [
            makeCandidate('a', 'TypeScript errors in build'),
            makeCandidate('b', 'React component structure'),
            makeCandidate('c', 'TypeScript config tsconfig'),
        ];
        const results = reranker.rerank('typescript errors', candidates);
        assert.strictEqual(results.length, 3);
    });

    test('promotes sessions more relevant to query', () => {
        const candidates = [
            makeCandidate('a', 'Python logging module'),
            makeCandidate('b', 'TypeScript strict null checks'),
            makeCandidate('c', 'CSS flexbox layout'),
        ];
        const results = reranker.rerank('typescript null', candidates);
        // The TypeScript session should rank first
        assert.strictEqual(results[0].id, 'b');
    });

    test('preserves original rank on ties', () => {
        const candidates = [
            makeCandidate('x', 'unrelated topic'),
            makeCandidate('y', 'another unrelated topic'),
        ];
        const results = reranker.rerank('zzzzzunknownzzz', candidates);
        // Ties should preserve original rank order
        assert.strictEqual(results[0].id, 'x');
        assert.strictEqual(results[1].id, 'y');
    });

});
