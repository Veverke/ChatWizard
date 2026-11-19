/**
 * test/unit/freeModel.test.ts
 *
 * The shared "ask a free model, best effort" component used by both KB
 * classification (`kbLlmClassifier`) and the Commands view description
 * (`commandPurpose`).
 *
 * The transport is injected, so these tests never touch the VS Code LM API and
 * never wait for real backoff (a no-op `sleep` is injected).
 */

import * as assert from 'assert';
import {
    FREE_MODEL_MAX_RETRIES,
    askFreeModel,
    clearFreeModelCache,
    hasFreeModelAnswer,
    isRateLimitedError,
    peekFreeModelAnswer,
} from '../../src/analytics/freeModel';

/** Records calls and yields the given answers in order. */
function scriptedCompletions(answers: Array<string | null | Error>): {
    complete: (systemPrompt: string | undefined, userContent: string, timeoutMs: number) => Promise<string | null>;
    calls: Array<{ systemPrompt: string | undefined; userContent: string; timeoutMs: number }>;
} {
    const calls: Array<{ systemPrompt: string | undefined; userContent: string; timeoutMs: number }> = [];
    let index = 0;
    return {
        calls,
        complete: async (systemPrompt, userContent, timeoutMs) => {
            calls.push({ systemPrompt, userContent, timeoutMs });
            const answer = answers[Math.min(index++, answers.length - 1)];
            if (answer instanceof Error) { throw answer; }
            return answer;
        },
    };
}

/** Backoff never actually waits in tests. */
const noSleep = {
    sleep: async (): Promise<void> => undefined,
};

suite('freeModel — asking', () => {
    setup(() => clearFreeModelCache());
    teardown(() => clearFreeModelCache());

    test('returns the raw answer when no transform is supplied', async () => {
        const model = scriptedCompletions(['plain answer']);
        const answer = await askFreeModel(
            { userContent: 'question', systemPrompt: 'sys', timeoutMs: 1_234 },
            { ...noSleep, complete: model.complete },
        );

        assert.strictEqual(answer, 'plain answer');
        assert.deepStrictEqual(model.calls, [{ systemPrompt: 'sys', userContent: 'question', timeoutMs: 1_234 }]);
    });

    test('applies the transform and supports non-string values', async () => {
        const model = scriptedCompletions(['{"count":3}']);
        const answer = await askFreeModel<number>(
            { userContent: 'question', transform: (raw) => Number(JSON.parse(raw).count) },
            { ...noSleep, complete: model.complete },
        );
        assert.strictEqual(answer, 3);
    });

    test('a blank prompt never reaches the model', async () => {
        const model = scriptedCompletions(['should not happen']);
        const answer = await askFreeModel({ userContent: '   \n ' }, { ...noSleep, complete: model.complete });

        assert.strictEqual(answer, null);
        assert.strictEqual(model.calls.length, 0);
    });

    test('no provider answering means null after a single attempt', async () => {
        const model = scriptedCompletions([null]);
        const answer = await askFreeModel({ userContent: 'question' }, { ...noSleep, complete: model.complete });

        assert.strictEqual(answer, null);
        assert.strictEqual(model.calls.length, 1, 'an unavailable provider is not retried');
    });

    test('a rate-limited request is retried, then succeeds', async () => {
        const model = scriptedCompletions([new Error('ChatRateLimited: too many requests'), 'second try wins']);
        const delays: number[] = [];
        const answer = await askFreeModel(
            { userContent: 'question', baseDelayMs: 10 },
            {
                complete: model.complete,
                sleep: async (ms) => { delays.push(ms); },
            },
        );

        assert.strictEqual(answer, 'second try wins');
        assert.strictEqual(model.calls.length, 2);
        assert.deepStrictEqual(delays, [10], 'exponential backoff uses the configured base');
    });

    test('a permanent failure is not retried', async () => {
        const model = scriptedCompletions([new Error('400 bad request'), 'never reached']);
        const answer = await askFreeModel({ userContent: 'question' }, { ...noSleep, complete: model.complete });

        assert.strictEqual(answer, null);
        assert.strictEqual(model.calls.length, 1);
    });

    test('exhausted rate-limit retries resolve to null', async () => {
        const model = scriptedCompletions([new Error('RateLimited')]);
        const answer = await askFreeModel(
            { userContent: 'question', maxRetries: 2 },
            { ...noSleep, complete: model.complete },
        );

        assert.strictEqual(answer, null);
        assert.strictEqual(model.calls.length, 3, 'initial attempt + 2 retries');
        assert.ok(FREE_MODEL_MAX_RETRIES >= 1);
    });

    test('a rejected answer is final unless retryRejectedAnswers is set', async () => {
        const model = scriptedCompletions(['garbage', 'garbage', 'good answer']);
        const transform = (raw: string): string | null => (raw === 'good answer' ? raw : null);

        const first = await askFreeModel({ userContent: 'question', transform }, { ...noSleep, complete: model.complete });
        assert.strictEqual(first, null);
        assert.strictEqual(model.calls.length, 1);

        const second = await askFreeModel(
            { userContent: 'question', transform, retryRejectedAnswers: true, maxRetries: 1 },
            { ...noSleep, complete: model.complete },
        );
        assert.strictEqual(second, 'good answer');
        assert.strictEqual(model.calls.length, 3, 'initial attempt + one retry after the rejected answer');
    });

    test('never throws when the transport explodes', async () => {
        const model = scriptedCompletions([new Error('model exploded')]);
        const answer = await askFreeModel({ userContent: 'question' }, { ...noSleep, complete: model.complete });
        assert.strictEqual(answer, null);
    });
});

suite('freeModel — caching and single-flight', () => {
    setup(() => clearFreeModelCache());
    teardown(() => clearFreeModelCache());

    test('a cached answer is served without asking the model again', async () => {
        const model = scriptedCompletions(['Searches JSON files.']);
        const request = {
            userContent: 'question',
            cacheKey: 'cmd-purpose:rg',
            transform: (raw: string) => raw.trim(),
        };

        const first = await askFreeModel(request, { ...noSleep, complete: model.complete });
        const second = await askFreeModel(request, { ...noSleep, complete: model.complete });

        assert.strictEqual(first, 'Searches JSON files.');
        assert.strictEqual(second, 'Searches JSON files.');
        assert.strictEqual(model.calls.length, 1, 'the second call is a cache hit');
        assert.strictEqual(peekFreeModelAnswer(request.cacheKey), 'Searches JSON files.');
    });

    test('"no answer" is cached too, and peeks as undefined', async () => {
        const model = scriptedCompletions([null]);
        const request = { userContent: 'question', cacheKey: 'cmd-purpose:no-model' };

        assert.strictEqual(await askFreeModel(request, { ...noSleep, complete: model.complete }), null);
        assert.strictEqual(await askFreeModel(request, { ...noSleep, complete: model.complete }), null);
        assert.strictEqual(model.calls.length, 1);
        assert.strictEqual(peekFreeModelAnswer(request.cacheKey), undefined);
    });

    test('concurrent requests for one key share a single model call', async () => {
        const model = scriptedCompletions(['shared answer']);
        const request = { userContent: 'question', cacheKey: 'cmd-purpose:shared' };

        const results = await Promise.all([
            askFreeModel(request, { ...noSleep, complete: model.complete }),
            askFreeModel(request, { ...noSleep, complete: model.complete }),
        ]);

        assert.deepStrictEqual(results, ['shared answer', 'shared answer']);
        assert.strictEqual(model.calls.length, 1);
    });

    test('requests without a cache key are never memoised', async () => {
        const model = scriptedCompletions(['answer']);
        await askFreeModel({ userContent: 'question' }, { ...noSleep, complete: model.complete });
        await askFreeModel({ userContent: 'question' }, { ...noSleep, complete: model.complete });
        assert.strictEqual(model.calls.length, 2);
    });

    test('clearing by prefix leaves other features\' answers alone', async () => {
        const model = scriptedCompletions(['answer']);
        const deps = { ...noSleep, complete: model.complete };

        await askFreeModel({ userContent: 'q', cacheKey: 'cmd-purpose:a' }, deps);
        await askFreeModel({ userContent: 'q', cacheKey: 'kb:b' }, deps);
        clearFreeModelCache('cmd-purpose:');

        assert.strictEqual(peekFreeModelAnswer('cmd-purpose:a'), undefined);
        assert.strictEqual(peekFreeModelAnswer('kb:b'), 'answer');
    });

    test('clearing everything drops namespaced answers', async () => {
        const model = scriptedCompletions(['answer']);
        await askFreeModel({ userContent: 'q', cacheKey: 'cmd-purpose:a' }, { ...noSleep, complete: model.complete });
        clearFreeModelCache();
        assert.strictEqual(peekFreeModelAnswer('cmd-purpose:a'), undefined);
    });

    test('hasFreeModelAnswer reports settled answers only, not in-flight ones', async () => {
        let release: (value: string | null) => void = () => undefined;
        const gate = new Promise<string | null>((resolve) => { release = resolve; });
        const request = { userContent: 'q', cacheKey: 'cmd-purpose:pending' };

        const pending = askFreeModel(request, { ...noSleep, complete: async () => gate });
        assert.strictEqual(hasFreeModelAnswer(request.cacheKey), false, 'in-flight is not settled');

        release('answer');
        await pending;
        assert.strictEqual(hasFreeModelAnswer(request.cacheKey), true, 'settled once it resolves');
    });
});

suite('freeModel — error classification', () => {
    test('recognises throttling messages', () => {
        assert.ok(isRateLimitedError(new Error('ChatRateLimited: too many requests')));
        assert.ok(isRateLimitedError('rate limit exceeded'));
        assert.ok(isRateLimitedError('RateLimited'));
    });

    test('does not treat permanent errors as throttling', () => {
        assert.ok(!isRateLimitedError(new Error('Network timeout')));
        assert.ok(!isRateLimitedError(''));
    });
});
