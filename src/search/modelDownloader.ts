// src/search/modelDownloader.ts

/**
 * Dependency-free model downloader used instead of letting transformers.js
 * fetch from the Hub.
 *
 * Why not let transformers.js download?  Its `fetch` gives us an opaque
 * `TypeError: fetch failed`, cannot use an HTTP proxy, and happily caches a
 * proxy's HTML block page as `model.onnx`.  Here every file is streamed to
 * `<file>.partial`, hashed while streaming, verified (size + SHA-256 from an
 * optional `manifest.json`, plus JSON/ONNX sanity checks) and only then
 * renamed into place — so a poisoned cache is impossible.
 *
 * Sources are tried in order, which is what lets corporate/offline users in:
 * local folder → mirror host (or HF_ENDPOINT) → huggingface.co → GitHub release.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as path from 'path';
import * as tls from 'tls';
import { URL } from 'url';
import { once } from 'events';
import { describeTrustStore, trustedCaBundle } from './systemCertificates';

/** Per-request (headers/body) timeout. */
const DEFAULT_TIMEOUT_MS = 120_000;
/** Attempts per file, per source (flaky proxies are common). */
const DEFAULT_ATTEMPTS = 2;
/** Redirect hops to follow (huggingface.co 302s to its CDN). */
const MAX_REDIRECTS = 5;
/** Anything smaller than this is an error page, not ONNX weights. */
const MIN_ONNX_BYTES = 1024 * 1024;
/** Guard against a runaway manifest read. */
const MAX_MANIFEST_BYTES = 512 * 1024;

export interface FileSpec {
    size?: number;
    sha256?: string;
    /**
     * Remote file name when it differs from the relative path.
     * GitHub release assets are flat, so `onnx/model_quantized.onnx` is published
     * as `model_quantized.onnx` and recorded here as `"asset"`.
     */
    asset?: string;
}

export interface ModelManifest {
    version?: number;
    files?: Record<string, FileSpec>;
}

export interface DownloadRequest {
    /** Base URLs tried in order; a trailing slash is added when missing. */
    baseUrls: readonly string[];
    /** Files to fetch, relative to the model folder (e.g. `onnx/model_quantized.onnx`). */
    files: readonly string[];
    /** Folder that receives the files (created when missing). */
    destDir: string;
    /** Progress callback — receives short human-readable lines. */
    onProgress?: (message: string) => void;
    /** Diagnostic log callback — source attempts, verification results, failures. */
    onLog?: (message: string) => void;
    /** Explicit proxy; defaults to HTTPS_PROXY / HTTP_PROXY. */
    proxyUrl?: string;
    /**
     * Also trust the operating system's CA store (default `true`).
     * Required on TLS-inspecting corporate networks, where Node's bundled roots
     * do not include the corporate root. Never disables verification.
     */
    useSystemCertificates?: boolean;
    /** Per-request timeout in ms. */
    timeoutMs?: number;
    /** Attempts per file, per source. */
    attempts?: number;
}

export interface DownloadResult {
    /** Base URL that served the files (`''` when nothing had to be fetched). */
    baseUrl: string;
    /** Files written during this call. */
    files: string[];
    /** Total bytes downloaded. */
    bytes: number;
    /** Whether a proxy was used. */
    usedProxy: boolean;
}


// ── URLs & proxy helpers (exported for tests) ─────────────────────────────────

/** Adds the trailing slash `new URL(relative, base)` needs. */
export function normalizeBaseUrl(baseUrl: string): string {
    const trimmed = (baseUrl ?? '').trim();
    if (!trimmed) {
        return '';
    }
    return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

/** Percent-encodes every path segment without touching the separators. */
export function encodeRelativePath(relativePath: string): string {
    return relativePath
        .split('/')
        .filter(segment => segment.length > 0)
        .map(segment => encodeURIComponent(segment))
        .join('/');
}

/** `NO_PROXY` / `no_proxy` support, including the `*` wildcard. */
export function shouldBypassProxy(hostname: string): boolean {
    const noProxy = process.env['NO_PROXY'] ?? process.env['no_proxy'] ?? '';
    if (!noProxy.trim() || !hostname) {
        return false;
    }
    const host = hostname.toLowerCase();
    return noProxy.split(',')
        .map(entry => entry.trim().toLowerCase())
        .filter(entry => entry.length > 0)
        .some(entry => {
            if (entry === '*') {
                return true;
            }
            const bare = entry.replace(/^\./, '').replace(/:\d+$/, '');
            return host === bare || host.endsWith(`.${bare}`);
        });
}

/** Explicit proxy → `HTTPS_PROXY`/`HTTP_PROXY` (unless `NO_PROXY` matches). */
export function resolveProxy(explicit: string | undefined, targetUrl?: string): URL | undefined {
    const env = process.env;
    const candidate = (explicit ?? '').trim()
        || env['HTTPS_PROXY']
        || env['https_proxy']
        || env['HTTP_PROXY']
        || env['http_proxy'];
    if (!candidate) {
        return undefined;
    }
    if (targetUrl && shouldBypassProxy(safeHostname(targetUrl))) {
        return undefined;
    }
    try {
        const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : `http://${candidate}`;
        const parsed = new URL(withScheme);
        return parsed.hostname ? parsed : undefined;
    } catch {
        return undefined;
    }
}

function safeHostname(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return '';
    }
}

// ── HTTP plumbing ─────────────────────────────────────────────────────────────

interface StreamResponse {
    status: number;
    headers: http.IncomingHttpHeaders;
    stream: http.IncomingMessage;
    /** URL that produced this response (after redirects) — used in error messages. */
    url: string;
}

/** Opens a CONNECT tunnel through an HTTP(S) proxy — required for HTTPS targets. */
function openTunnel(proxy: URL, host: string, port: number, ca?: readonly string[]): Promise<net.Socket> {
    return new Promise<net.Socket>((resolve, reject) => {
        const isHttpsProxy = proxy.protocol === 'https:';
        const proxyPort = proxy.port ? Number(proxy.port) : (isHttpsProxy ? 443 : 80);
        const headers: Record<string, string> = { Host: `${host}:${port}` };
        if (proxy.username || proxy.password) {
            const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
            headers['Proxy-Authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`;
        }
        // Built as a variable so `ca` / `servername` avoid excess-property checks.
        const options: https.RequestOptions = {
            host: proxy.hostname,
            port: proxyPort,
            method: 'CONNECT',
            path: `${host}:${port}`,
            headers,
            ...(ca ? { ca: [...ca] } : {}),
        };
        const req = isHttpsProxy ? https.request(options) : http.request(options);
        req.on('connect', (res, socket) => {
            if (res.statusCode !== 200) {
                socket.destroy();
                reject(new Error(`Proxy CONNECT failed with status ${res.statusCode ?? 0}`));
                return;
            }
            resolve(socket as net.Socket);
        });
        req.on('error', reject);
        req.end();
    });
}

function sendGet(url: URL, proxy: URL | undefined, timeoutMs: number, ca?: readonly string[]): Promise<StreamResponse> {
    const isHttps = url.protocol === 'https:';
    const port = url.port ? Number(url.port) : (isHttps ? 443 : 80);
    const target = `${url.pathname}${url.search}`;
    const headers: Record<string, string> = { 'User-Agent': 'ChatWizard', Accept: '*/*', Host: url.host };

    const settle = (req: http.ClientRequest): Promise<StreamResponse> =>
        new Promise<StreamResponse>((resolve, reject) => {
            const timer = setTimeout(() => {
                req.destroy(new Error(`Request timed out after ${timeoutMs}ms: ${url.toString()}`));
            }, timeoutMs);
            timer.unref();
            req.on('response', (res: http.IncomingMessage) => {
                clearTimeout(timer);
                resolve({ status: res.statusCode ?? 0, headers: res.headers, stream: res, url: url.toString() });
            });
            req.on('error', (err: Error) => {
                clearTimeout(timer);
                reject(err);
            });
            req.end();
        });

    if (proxy && isHttps) {
        return openTunnel(proxy, url.hostname, port, ca).then(socket => {
            // Built as a variable so `servername` / `createConnection` don't trip
            // excess-property checks against https.RequestOptions.
            const trusted = ca ? [...ca] : undefined;
            const tunnelOptions = {
                host: url.hostname,
                port,
                path: target,
                method: 'GET',
                headers,
                servername: url.hostname,
                createConnection: () => tls.connect({
                    socket,
                    servername: url.hostname,
                    ...(trusted ? { ca: trusted } : {}),
                }),
            };
            return settle(https.request(tunnelOptions));
        });
    }
    if (proxy) {
        // Plain HTTP through a proxy uses the absolute-form request target.
        return settle(http.request({
            host: proxy.hostname,
            port: proxy.port ? Number(proxy.port) : 80,
            path: url.toString(),
            method: 'GET',
            headers,
        }));
    }
    const options: https.RequestOptions = {
        host: url.hostname,
        port,
        path: target,
        method: 'GET',
        headers,
        ...(ca ? { ca: [...ca] } : {}),
    };
    return settle(isHttps ? https.request(options) : http.request(options));
}

async function requestStream(
    url: URL,
    proxy: URL | undefined,
    timeoutMs: number,
    redirectsLeft: number = MAX_REDIRECTS,
    ca?: readonly string[],
): Promise<StreamResponse> {
    const response = await sendGet(url, proxy, timeoutMs, ca);
    const location = response.headers.location;
    if (response.status >= 300 && response.status < 400 && location && redirectsLeft > 0) {
        response.stream.resume();
        return requestStream(new URL(location, url), proxy, timeoutMs, redirectsLeft - 1, ca);
    }
    return response;
}

// ── File transfer & verification ──────────────────────────────────────────────

function delay(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
        const timer = setTimeout(resolve, ms);
        timer.unref();
    });
}

async function withRetries<T>(task: () => Promise<T>, attempts: number): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            return await task();
        } catch (err) {
            lastError = err;
            if (attempt + 1 < attempts) {
                await delay(1_000 * (attempt + 1));
            }
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Rejects downloads that are truncated, tampered with, or an HTML block page. */
async function verifyDownloaded(
    filePath: string,
    remotePath: string,
    expected: FileSpec | undefined,
    size: number,
    head: Buffer | undefined,
    sha256: string,
): Promise<void> {
    if (typeof expected?.size === 'number' && expected.size !== size) {
        throw new Error(`Checksum mismatch for ${remotePath}: expected ${expected.size} bytes, got ${size} (corrupt download)`);
    }
    if (expected?.sha256 && expected.sha256.trim().toLowerCase() !== sha256) {
        throw new Error(`Checksum mismatch for ${remotePath}: sha256 ${sha256} does not match the manifest (corrupt download)`);
    }

    const lower = remotePath.toLowerCase();
    if (lower.endsWith('.json')) {
        const text = await fs.promises.readFile(filePath, 'utf8');
        try {
            JSON.parse(text);
        } catch {
            throw new Error(`Downloaded ${remotePath} is not valid JSON — likely an HTML block page from a proxy (corrupt download)`);
        }
        return;
    }
    if (lower.endsWith('.onnx')) {
        if (size < MIN_ONNX_BYTES) {
            throw new Error(`Downloaded ${remotePath} is only ${size} bytes — corrupt or incomplete`);
        }
        if (head && head[0] === 0x3c /* '<' */) {
            throw new Error(`Downloaded ${remotePath} looks like an HTML page, not ONNX weights (corrupt download)`);
        }
    }
}

/** Streams a URL to `destPath` atomically (`.partial` → rename) and verifies it. */
async function downloadFile(
    url: URL,
    destPath: string,
    expected: FileSpec | undefined,
    onProgress: ((received: number, total: number) => void) | undefined,
    proxy: URL | undefined,
    timeoutMs: number,
    ca?: readonly string[],
): Promise<number> {
    const response = await requestStream(url, proxy, timeoutMs, MAX_REDIRECTS, ca);
    if (response.status !== 200) {
        response.stream.resume();
        // Name the URL that actually answered: a blocked CDN shows up here, not
        // in the huggingface.co URL that was requested.
        const where = response.url && response.url !== url.toString()
            ? `${response.url} (redirected from ${url.toString()})`
            : url.toString();
        throw new Error(`Download failed with HTTP ${response.status} for ${where}`);
    }

    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    const tmpPath = `${destPath}.partial`;
    const hash = crypto.createHash('sha256');
    const total = Number(response.headers['content-length'] ?? 0);
    let received = 0;
    let head: Buffer | undefined;
    const out = fs.createWriteStream(tmpPath);

    try {
        for await (const chunk of response.stream) {
            const buffer = chunk as Buffer;
            if (!head) {
                head = buffer.subarray(0, Math.min(buffer.length, 32));
            }
            hash.update(buffer);
            received += buffer.length;
            if (!out.write(buffer)) {
                await once(out, 'drain');
            }
            onProgress?.(received, total);
        }
        await new Promise<void>((resolve, reject) => {
            out.once('error', reject);
            out.end(resolve);
        });
    } catch (err) {
        out.destroy();
        await fs.promises.rm(tmpPath, { force: true });
        throw err;
    }

    try {
        await verifyDownloaded(tmpPath, url.pathname, expected, received, head, hash.digest('hex'));
        await fs.promises.rename(tmpPath, destPath);
    } catch (err) {
        await fs.promises.rm(tmpPath, { force: true });
        throw err;
    }
    return received;
}

/** SHA-256 of a file, streamed (used by the asset-preparation script). */
export async function sha256File(filePath: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    await new Promise<void>((resolve, reject) => {
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk: Buffer | string) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', resolve);
    });
    return hash.digest('hex');
}

// ── Manifest ──────────────────────────────────────────────────────────────────

/**
 * Reads `<base>/manifest.json` when present.
 * Shape: `{ "version": 1, "files": { "config.json": { "size": 648, "sha256": "…" } } }`
 * A missing/invalid manifest is not an error — verification then falls back to
 * the structural checks above.
 */
async function fetchManifest(
    baseUrl: string,
    proxy: URL | undefined,
    timeoutMs: number,
    ca?: readonly string[],
): Promise<Record<string, FileSpec> | undefined> {
    try {
        const response = await requestStream(new URL('manifest.json', baseUrl), proxy, timeoutMs, MAX_REDIRECTS, ca);
        if (response.status !== 200) {
            response.stream.resume();
            return undefined;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of response.stream) {
            const buffer = chunk as Buffer;
            size += buffer.length;
            if (size > MAX_MANIFEST_BYTES) {
                return undefined;
            }
            chunks.push(buffer);
        }
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ModelManifest;
        return parsed && typeof parsed === 'object' && parsed.files ? parsed.files : undefined;
    } catch {
        return undefined;
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** True when `candidate` is an existing regular file. */
function fileExists(candidate: string): boolean {
    try {
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}

/**
 * Downloads `files` into `destDir`, trying `baseUrls` in order.
 * Resolves with the source that worked; throws with every failure chained when
 * all sources are exhausted.
 *
 * A source does not have to serve the whole set: files are renamed into place
 * only after they verify, so anything an earlier source delivered is kept and a
 * later source only fetches what is still missing. Content filters routinely
 * allow the small metadata files while blocking the large weights, and mirrors
 * can be partially populated, so this is the normal case rather than an edge.
 */
export async function downloadModelFiles(request: DownloadRequest): Promise<DownloadResult> {
    const files = [...new Set(request.files)].filter(file => file && file.trim().length > 0);
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const attempts = Math.max(1, request.attempts ?? DEFAULT_ATTEMPTS);
    const proxy = resolveProxy(request.proxyUrl);
    const sourceCount = request.baseUrls.filter(url => normalizeBaseUrl(url)).length;
    // Corporate networks that intercept TLS: trust the OS store as well, so the
    // certificate chain validates. Verification stays enabled — see
    // systemCertificates.ts (no `rejectUnauthorized: false` anywhere).
    const ca = trustedCaBundle(request.useSystemCertificates !== false);

    if (files.length === 0) {
        return { baseUrl: '', files: [], bytes: 0, usedProxy: proxy !== undefined };
    }

    const failures: string[] = [];
    let sourceIndex = 0;
    for (const candidate of request.baseUrls) {
        const baseUrl = normalizeBaseUrl(candidate);
        if (!baseUrl) {
            continue;
        }
        sourceIndex++;
        const proxyForSource = resolveProxy(request.proxyUrl, baseUrl);
        request.onLog?.(
            `Source ${sourceIndex}/${sourceCount}: ${baseUrl}`
            + (proxyForSource ? ` (via proxy ${proxyForSource.host})` : ''),
        );
        if (sourceIndex === 1) {
            request.onLog?.(describeTrustStore(ca));
        }

        // Only fetch what is still missing — a file exists here only because it
        // was verified, and a previous source may already have delivered some.
        const pending = files.filter(file => !fileExists(path.join(request.destDir, ...file.split('/'))));
        if (pending.length === 0) {
            request.onLog?.('  every file is already on disk — nothing left to download');
            return { baseUrl, files, bytes: 0, usedProxy: proxyForSource !== undefined };
        }
        if (pending.length < files.length) {
            request.onLog?.(
                `  ${files.length - pending.length} file(s) already on disk — fetching the remaining ${pending.length}`,
            );
        }

        try {
            const manifest = await fetchManifest(baseUrl, proxyForSource, timeoutMs, ca);
            request.onLog?.(manifest
                ? 'manifest.json found — verifying size + SHA-256 for every file'
                : 'No manifest.json at this source — verifying file structure only');
            let bytes = 0;
            for (let index = 0; index < pending.length; index++) {
                const file = pending[index];
                const label = `${path.basename(file)} (${index + 1}/${pending.length})`;
                const expected = manifest?.[file.replace(/\\/g, '/')];
                const destPath = path.join(request.destDir, ...file.split('/'));
                // Release assets are flat — the manifest may rename the remote file.
                const remotePath = expected?.asset?.trim() || file;
                request.onProgress?.(`Downloading ${label}…`);
                const fileBytes = await withRetries(
                    () => downloadFile(
                        new URL(encodeRelativePath(remotePath), baseUrl),
                        destPath,
                        expected,
                        (received, total) => {
                            const pct = total > 0 ? Math.round((received / total) * 100) : 0;
                            request.onProgress?.(`Downloading ${label}: ${pct}%`);
                        },
                        proxyForSource,
                        timeoutMs,
                        ca,
                    ),
                    attempts,
                );
                bytes += fileBytes;
                request.onLog?.(`  ✓ ${file} — ${(fileBytes / (1024 * 1024)).toFixed(1)} MB, verified`);
            }
            return { baseUrl, files, bytes, usedProxy: proxyForSource !== undefined };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            failures.push(`${baseUrl} -> ${message}`);
            request.onLog?.(`  ✗ ${baseUrl} failed: ${message}`);
            request.onProgress?.('Source unavailable — trying the next one…');
        }
    }

    throw new Error(`All model download sources failed: ${failures.join(' | ')}`);
}



