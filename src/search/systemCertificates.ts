// src/search/systemCertificates.ts

/**
 * TLS trust anchors for the model downloader.
 *
 * Node ships its **own** CA bundle and ignores the operating system's store.
 * On a network with a TLS-inspecting proxy or security appliance (any product
 * that re-signs traffic), every `https://` request therefore fails with
 * `unable to get local issuer certificate` — while the browser and `git`, which
 * *do* read the OS store, work fine. That mismatch is what produced the opaque
 * `TypeError: fetch failed` this feature was reported with.
 *
 * Node ≥ 22.15 / 24 exposes `tls.getCACertificates('system')`, so on those
 * builds we add the OS roots to the bundled ones and keep **full certificate
 * verification** — we only ever *add* trust anchors, never disable validation
 * (`rejectUnauthorized: false` is deliberately not used anywhere).
 */

import * as tls from 'tls';

/** `tls.getCACertificates` is newer than this repo's `@types/node`, so type it here. */
type TlsWithCaApi = typeof tls & {
    getCACertificates?: (type?: 'default' | 'system' | 'bundled' | 'extra') => string[];
};

/** True when this Node/Electron build can read the operating system's CA store. */
export function hasSystemCertificateStore(): boolean {
    return typeof (tls as TlsWithCaApi).getCACertificates === 'function';
}

/** PEM roots from the OS store — empty when unsupported (older Node/Electron). */
export function systemCaCertificates(): string[] {
    return caList('system');
}

/**
 * `tls.getCACertificates` wrapper for one bucket. Node replaces its whole trust
 * list when `ca` is passed, so every bucket has to be merged explicitly —
 * including `extra` (the roots a user supplied through NODE_EXTRA_CA_CERTS).
 */
function caList(type: 'system' | 'extra' | 'default' | 'bundled'): string[] {
    const api = tls as TlsWithCaApi;
    if (typeof api.getCACertificates !== 'function') {
        return [];
    }
    try {
        const certificates = api.getCACertificates(type);
        return Array.isArray(certificates)
            ? certificates.filter(cert => typeof cert === 'string' && cert.includes('-----BEGIN CERTIFICATE-----'))
            : [];
    } catch {
        return [];
    }
}

let cachedBundle: string[] | undefined;

/**
 * Node's bundled roots, the OS store, and any NODE_EXTRA_CA_CERTS roots —
 * de-duplicated.
 *
 * Returns `undefined` when only the bundled roots are usable, so callers leave
 * `ca` unset and Node's default behaviour is unchanged.
 */
export function trustedCaBundle(includeSystem: boolean = true): string[] | undefined {
    if (!includeSystem || !hasSystemCertificateStore()) {
        return undefined;
    }
    if (cachedBundle) {
        return cachedBundle;
    }
    const seen = new Set<string>();
    const bundle: string[] = [];
    for (const certificate of [...tls.rootCertificates, ...caList('system'), ...caList('extra')]) {
        if (!seen.has(certificate)) {
            seen.add(certificate);
            bundle.push(certificate);
        }
    }
    cachedBundle = bundle;
    return bundle;
}

/** One-line description of the effective trust store, for the output channel. */
export function describeTrustStore(bundle: string[] | undefined): string {
    const bundled = tls.rootCertificates.length;
    if (bundle) {
        return `TLS trust: ${bundle.length} CA certificate(s) — Node bundled (${bundled}) `
            + `+ OS store (${caList('system').length}) + extra (${caList('extra').length})`;
    }
    if (hasSystemCertificateStore()) {
        return `TLS trust: Node's bundled roots only (${bundled})`;
    }
    return `TLS trust: Node's bundled roots only (${bundled}) — this build cannot read the OS store; `
        + 'set NODE_EXTRA_CA_CERTS on TLS-inspecting networks';
}
