// src/search/modelLoadDiagnostics.ts

/**
 * Turns the various ways a model load/download can fail into a small set of
 * kinds with user-facing wording.
 *
 * Everything here is pure (no `vscode`, no I/O) so it can be unit-tested and
 * reused by the extension and by the asset-preparation script.
 */

export type ModelFailureKind =
    /** TLS interception / DNS / egress filtering / 403 — the usual corporate case. */
    | 'blocked'
    /** The network re-signs HTTPS with a CA Node does not trust (corporate proxy). */
    | 'tls'
    /** A proxy was in play and rejected or broke the tunnelled request. */
    | 'proxy'
    /** 404 — the file is not where we looked (wrong mirror, missing GH asset). */
    | 'not-found'
    /** Downloaded bytes failed verification (HTML block page, truncated file). */
    | 'corrupt'
    /** Request or whole-download timeout. */
    | 'timeout'
    /** A local folder is configured but incomplete. */
    | 'local-incomplete'
    | 'unknown';

export interface ModelFailure {
    kind: ModelFailureKind;
    /** Original error message, trimmed for display. */
    message: string;
}

const MAX_MESSAGE_LENGTH = 400;

const PATTERNS: ReadonlyArray<{ kind: ModelFailureKind; re: RegExp }> = [
    { kind: 'timeout', re: /timed out|timeout|etimedout|esockettimedout/i },
    { kind: 'proxy', re: /proxy|tunnel|407/i },
    // Node's own CA store missing a corporate root — the classic "fetch failed"
    // cause behind a TLS-inspecting proxy. Must be matched before 'blocked'.
    {
        kind: 'tls',
        re: /unable to get local issuer certificate|unable to verify the first certificate|unable to verify|self[- ]signed certificate|self[- ]signed|local issuer|ERR_TLS_CERT|certificate verify failed|CERT_HAS_EXPIRED|certificate has expired/i,
    },
    { kind: 'local-incomplete', re: /incomplete|is missing|missing required|not a valid model folder/i },
    { kind: 'corrupt', re: /corrupt|checksum|sha256|sha-256|invalid json|unexpected token|unexpected end of|html/i },
    { kind: 'not-found', re: /\b404\b|not found|enoent|no such file|could not locate/i },
    {
        kind: 'blocked',
        re: /fetch failed|enotfound|eai_again|econnrefused|econnreset|econnaborted|socket hang up|403|forbidden|network|getaddrinfo|blocked/i,
    },
];

/** Normalises anything thrown into a `{ kind, message }` pair. */
export function classifyModelError(error: unknown): ModelFailure {
    const message = (error instanceof Error
        ? error.message
        : typeof error === 'string' ? error : String(error))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_MESSAGE_LENGTH);

    for (const entry of PATTERNS) {
        if (entry.re.test(message)) {
            return { kind: entry.kind, message };
        }
    }
    return { kind: 'unknown', message };
}

/**
 * One-sentence reason, grammatically usable as:
 * `semantic search is unavailable — {summary}.`
 */
export function modelFailureSummary(kind: ModelFailureKind): string {
    switch (kind) {
        case 'blocked':
            return 'the AI model could not be downloaded (the network appears to block or intercept the download)';
        case 'proxy':
            return 'the AI model could not be downloaded through the configured proxy';
        case 'tls':
            return 'the AI model download was blocked by TLS certificate verification (a corporate proxy is re-signing the connection)';
        case 'not-found':
            return 'the AI model files were not found at any of the configured sources';
        case 'corrupt':
            return 'the downloaded AI model files failed verification (incomplete or altered download)';
        case 'timeout':
            return 'downloading the AI model timed out';
        case 'local-incomplete':
            return 'the configured local model folder is incomplete';
        default:
            return 'the AI model could not be loaded';
    }
}


export interface ModelFailureHintContext {
    /** Local folder explicitly configured/pre-staged by the user, if any. */
    localPath?: string;
    /** Mirror host configured by the user, if any. */
    mirrorHost?: string;
    /** How many download sources were attempted. */
    sourceCount?: number;
}

/** Actionable, multi-line hint written to the output channel / shown in the UI. */
export function modelFailureHint(kind: ModelFailureKind, ctx: ModelFailureHintContext = {}): string {
    const local = ctx.localPath?.trim();
    const mirror = ctx.mirrorHost?.trim();

    switch (kind) {
        case 'local-incomplete':
            return local
                ? `The folder "${local}" must contain config.json, tokenizer.json and onnx/model_quantized.onnx. `
                    + 'Fix the folder or clear "chatwizard.semanticModelPath" to download instead.'
                : 'The configured local model folder is incomplete. '
                    + 'Fix the folder or clear "chatwizard.semanticModelPath".';
        case 'tls':
            return [
                'The connection is re-signed by a TLS-inspecting proxy, and its root CA is not trusted. '
                    + 'Chat Wizard already adds the operating system certificate store to Node\'s bundled roots, '
                    + 'so the proxy root is missing from this machine\'s store. Options:',
                '  1. Install the corporate root CA in the OS store, or set NODE_EXTRA_CA_CERTS to that .pem file, '
                    + 'then restart VS Code.',
                '  2. "Chat Wizard: Configure AI Model Source…" -> use a mirror host or an internal host.',
                '  3. Point "chatwizard.semanticModelPath" at a folder holding the 4 model files.',
                'Keyword search keeps working regardless.',
            ].join('\n');
        case 'blocked':
        case 'proxy':
            return [
                'Semantic search needs no network access once the model is on disk. Options:',
                '  1. "Chat Wizard: Configure AI Model Source…" -> use a mirror host '
                    + '(e.g. https://hf-mirror.com) or an internal HF-compatible host.',
                '  2. Download the 4 model files on a machine with internet access and point '
                    + '"chatwizard.semanticModelPath" at that folder.',
                '  3. If an HTTP proxy is required, set HTTPS_PROXY / HTTP_PROXY (and NO_PROXY) for VS Code.',
                '  4. If the metadata downloads but the .onnx file returns HTTP 403 with an HTML body, a content '
                    + 'filter is blocking the model CDN. Publish the "Semantic model assets" workflow once and '
                    + 'the GitHub release asset is used instead.',
                'Keyword search keeps working regardless.',
            ].join('\n');
        case 'not-found':
            return [
                ctx.sourceCount !== undefined && ctx.sourceCount > 0
                    ? `All ${ctx.sourceCount} configured source(s) returned 404.`
                    : 'The files were not found.',
                mirror
                    ? `Check the mirror host "${mirror}" - it must mirror huggingface.co/<repo>/resolve/<revision>/.`
                    : 'Check "chatwizard.semanticModelMirror" and "chatwizard.semanticModelPath".',
                'The GitHub release asset used as a last resort may not be published for this build.',
            ].join('\n');
        case 'corrupt':
            return 'The downloaded files did not match their expected size/checksum - usually a proxy '
                + 'returning an HTML block page. Run "Chat Wizard: Reset AI Model Cache" and retry, '
                + 'preferably with a mirror host or a local model folder.';
        case 'timeout':
            return 'The download did not finish in time. Retry, use a mirror host, or point '
                + '"chatwizard.semanticModelPath" at a pre-downloaded model folder.';
        default:
            return 'See the "Chat Wizard" output channel for the full error. Keyword search keeps working.';
    }
}
