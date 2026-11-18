// test/unit/modelLoadDiagnostics.test.ts
// Unit tests for the model-failure classification used by the notification UI.

import * as assert from 'assert';
import {
    classifyModelError,
    modelFailureHint,
    modelFailureSummary,
} from '../../src/search/modelLoadDiagnostics';

suite('modelLoadDiagnostics.classifyModelError', () => {
    test('TypeError: fetch failed is treated as a blocked network', () => {
        const failure = classifyModelError(new TypeError('fetch failed'));
        assert.strictEqual(failure.kind, 'blocked');
        assert.match(failure.message, /fetch failed/);
    });

    test('DNS and 403 problems are treated as blocked', () => {
        assert.strictEqual(classifyModelError(new Error('getaddrinfo ENOTFOUND huggingface.co')).kind, 'blocked');
        assert.strictEqual(classifyModelError(new Error('request failed with 403 Forbidden')).kind, 'blocked');
    });

    test('TLS interception is its own kind (it needs different advice)', () => {
        assert.strictEqual(classifyModelError(new Error('self signed certificate in certificate chain')).kind, 'tls');
        assert.strictEqual(
            classifyModelError(new Error('unable to get local issuer certificate')).kind,
            'tls',
        );
    });

    test('proxy errors are recognised', () => {
        assert.strictEqual(classifyModelError(new Error('Proxy CONNECT failed with status 407')).kind, 'proxy');
    });

    test('timeouts are recognised', () => {
        assert.strictEqual(classifyModelError(new Error('Request timed out after 120000ms')).kind, 'timeout');
        assert.strictEqual(classifyModelError(new Error('connect ETIMEDOUT 1.2.3.4:443')).kind, 'timeout');
    });

    test('404s are reported as not-found', () => {
        assert.strictEqual(classifyModelError(new Error('Download failed with HTTP 404 for x')).kind, 'not-found');
        assert.strictEqual(classifyModelError(new Error('ENOENT: no such file or directory')).kind, 'not-found');
    });

    test('verification failures are reported as corrupt', () => {
        assert.strictEqual(
            classifyModelError(new Error('Downloaded config.json is not valid JSON (corrupt download)')).kind,
            'corrupt',
        );
        assert.strictEqual(classifyModelError(new Error('sha256 mismatch (corrupt download)')).kind, 'corrupt');
    });

    test('incomplete local folders are recognised', () => {
        assert.strictEqual(
            classifyModelError(new Error('Local model folder "C:/m" is incomplete — missing tokenizer.json')).kind,
            'local-incomplete',
        );
    });

    test('unknown errors fall back to unknown and keep the message', () => {
        const failure = classifyModelError(new Error('something odd happened'));
        assert.strictEqual(failure.kind, 'unknown');
        assert.strictEqual(failure.message, 'something odd happened');
    });

    test('normalises multi-line messages and non-Error values', () => {
        assert.strictEqual(classifyModelError('line one\n   line two').message, 'line one line two');
        assert.strictEqual(classifyModelError(undefined).kind, 'unknown');
    });
});

suite('modelLoadDiagnostics wording', () => {
    test('every kind produces a summary', () => {
        const kinds = [
            'blocked', 'tls', 'proxy', 'not-found', 'corrupt', 'timeout', 'local-incomplete', 'unknown',
        ] as const;
        for (const kind of kinds) {
            assert.ok(modelFailureSummary(kind).length > 10, `summary for ${kind}`);
        }
    });

    test('the tls hint points at NODE_EXTRA_CA_CERTS', () => {
        const hint = modelFailureHint('tls');
        assert.match(hint, /NODE_EXTRA_CA_CERTS/);
        assert.match(hint, /semanticModelPath/);
    });

    test('hints name the escape hatches for blocked networks', () => {
        const hint = modelFailureHint('blocked');
        assert.match(hint, /mirror/i);
        assert.match(hint, /semanticModelPath/);
        assert.match(hint, /HTTPS_PROXY/);
    });

    test('local-incomplete hint includes the configured folder', () => {
        const hint = modelFailureHint('local-incomplete', { localPath: 'C:/models/minilm' });
        assert.match(hint, /C:\/models\/minilm/);
    });

    test('not-found hint mentions the mirror when one is configured', () => {
        const hint = modelFailureHint('not-found', { mirrorHost: 'https://hf-mirror.com', sourceCount: 3 });
        assert.match(hint, /hf-mirror\.com/);
        assert.match(hint, /3 configured source/);
    });
});
