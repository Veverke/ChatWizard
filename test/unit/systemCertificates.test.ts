// test/unit/systemCertificates.test.ts
// Unit tests for the OS trust-store support used by the model downloader.
// These must pass on both old Node (no `tls.getCACertificates`) and new Node.

import * as assert from 'assert';
import * as tls from 'tls';
import {
    describeTrustStore,
    hasSystemCertificateStore,
    systemCaCertificates,
    trustedCaBundle,
} from '../../src/search/systemCertificates';

suite('systemCertificates', () => {
    test('capability probe never throws', () => {
        assert.strictEqual(typeof hasSystemCertificateStore(), 'boolean');
        assert.ok(Array.isArray(systemCaCertificates()));
    });

    test('returns only PEM certificate blocks', () => {
        for (const certificate of systemCaCertificates()) {
            assert.ok(
                certificate.includes('-----BEGIN CERTIFICATE-----'),
                'every entry must be a PEM certificate',
            );
        }
    });

    test('bundle keeps every bundled root and has no duplicates', () => {
        const bundle = trustedCaBundle();
        if (!hasSystemCertificateStore()) {
            assert.strictEqual(bundle, undefined, 'older Node must fall back to Node defaults');
            return;
        }
        assert.ok(bundle, 'expected a bundle when the API exists');
        for (const certificate of tls.rootCertificates) {
            assert.ok(bundle!.includes(certificate), 'Node bundled roots must be preserved');
        }
        assert.strictEqual(new Set(bundle).size, bundle!.length, 'no duplicate certificates');
    });

    test('opting out leaves Node defaults untouched', () => {
        assert.strictEqual(trustedCaBundle(false), undefined);
    });

    test('describeTrustStore always produces a usable log line', () => {
        assert.match(describeTrustStore(trustedCaBundle()), /^TLS trust: /);
        assert.match(describeTrustStore(undefined), /^TLS trust: /);
    });
});
