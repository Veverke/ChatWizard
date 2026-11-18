// test/unit/modelDownloader.test.ts
// Unit tests for the dependency-free, proxy-aware model downloader.
// Everything runs against a local HTTP server — no external network access.

import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import {
    downloadModelFiles,
    encodeRelativePath,
    normalizeBaseUrl,
    resolveProxy,
    shouldBypassProxy,
} from '../../src/search/modelDownloader';

interface Route {
    body: string | Buffer;
    status?: number;
    headers?: Record<string, string>;
}

interface TestServer {
    baseUrl: string;
    /** Paths requested, in order — lets tests assert what was (not) fetched. */
    requests: string[];
    close: () => Promise<void>;
}

/** Starts a throwaway HTTP server; unknown paths answer 404. */
async function startServer(routes: Record<string, Route>): Promise<TestServer> {
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
        const path_ = req.url ?? '/';
        requests.push(path_);
        const route = routes[path_];
        if (!route) {
            res.statusCode = 404;
            res.end('not found');
            return;
        }
        res.statusCode = route.status ?? 200;
        for (const [name, value] of Object.entries(route.headers ?? {})) {
            res.setHeader(name, value);
        }
        const body = Buffer.isBuffer(route.body) ? route.body : Buffer.from(route.body, 'utf8');
        res.setHeader('content-length', String(body.length));
        res.end(body);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return {
        baseUrl: `http://127.0.0.1:${port}/`,
        requests,
        close: () => new Promise<void>((resolve, reject) => {
            server.close(err => (err ? reject(err) : resolve()));
        }),
    };
}

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const;

/** Puts an environment variable back exactly as it was (`undefined` = delete it). */
function restoreEnv(key: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[key];
    } else {
        process.env[key] = value;
    }
}

suite('modelDownloader.downloadModelFiles', () => {
    const savedEnv: Record<string, string | undefined> = {};
    let destDir: string;

    setup(() => {
        // A developer machine may export a proxy; it would break 127.0.0.1 requests.
        for (const key of PROXY_VARS) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
        destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-model-download-'));
    });

    teardown(() => {
        for (const key of PROXY_VARS) {
            const value = savedEnv[key];
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
        fs.rmSync(destDir, { recursive: true, force: true });
    });

    test('downloads the requested files and leaves no partial files behind', async () => {
        const server = await startServer({
            '/config.json': { body: '{"model_type":"bert"}' },
            '/tokenizer.json': { body: '{"version":"1.0"}' },
        });
        try {
            const result = await downloadModelFiles({
                baseUrls: [server.baseUrl],
                files: ['config.json', 'tokenizer.json'],
                destDir,
                attempts: 1,
            });
            assert.strictEqual(result.baseUrl, server.baseUrl);
            assert.ok(result.bytes > 0);
            assert.strictEqual(
                fs.readFileSync(path.join(destDir, 'config.json'), 'utf8'),
                '{"model_type":"bert"}',
            );
            assert.ok(fs.existsSync(path.join(destDir, 'tokenizer.json')));
            assert.ok(!fs.existsSync(path.join(destDir, 'config.json.partial')));
        } finally {
            await server.close();
        }
    });

    test('names the redirect target when a blocked CDN answers', async () => {
        const server = await startServer({
            '/config.json': { body: '', status: 302, headers: { location: '/cdn/config.json' } },
            '/cdn/config.json': { body: '<html>blocked</html>', status: 403 },
        });
        try {
            await assert.rejects(
                () => downloadModelFiles({
                    baseUrls: [server.baseUrl],
                    files: ['config.json'],
                    destDir,
                    attempts: 1,
                }),
                (err: Error) => {
                    // Which host blocked us is the whole point of the message.
                    assert.match(err.message, /HTTP 403/);
                    assert.match(err.message, /\/cdn\/config\.json/);
                    assert.match(err.message, /redirected from/);
                    return true;
                },
            );
            assert.ok(!fs.existsSync(path.join(destDir, 'config.json')), 'nothing written on failure');
        } finally {
            await server.close();
        }
    });

    test('creates nested folders for onnx/ files', async () => {
        const payload = Buffer.alloc(1024 * 1024 + 8, 8); // > MIN_ONNX_BYTES, not '<'
        const server = await startServer({ '/onnx/model_quantized.onnx': { body: payload } });
        try {
            await downloadModelFiles({
                baseUrls: [server.baseUrl],
                files: ['onnx/model_quantized.onnx'],
                destDir,
                attempts: 1,
            });
            assert.ok(fs.existsSync(path.join(destDir, 'onnx', 'model_quantized.onnx')));
        } finally {
            await server.close();
        }
    });

    test('honours the sha256 recorded in manifest.json', async () => {
        const body = '{"model_type":"bert"}';
        const sha256 = crypto.createHash('sha256').update(body).digest('hex');
        const manifest = JSON.stringify({
            version: 1,
            files: { 'config.json': { size: Buffer.byteLength(body), sha256 } },
        });
        const server = await startServer({
            '/manifest.json': { body: manifest },
            '/config.json': { body },
        });
        try {
            await downloadModelFiles({
                baseUrls: [server.baseUrl],
                files: ['config.json'],
                destDir,
                attempts: 1,
            });
            assert.ok(fs.existsSync(path.join(destDir, 'config.json')));
        } finally {
            await server.close();
        }
    });

    test('rejects a file whose checksum does not match the manifest', async () => {
        const manifest = JSON.stringify({
            version: 1,
            files: { 'config.json': { size: 2, sha256: 'deadbeef' } },
        });
        const server = await startServer({
            '/manifest.json': { body: manifest },
            '/config.json': { body: '{"a":1}' },
        });
        try {
            await assert.rejects(
                () => downloadModelFiles({
                    baseUrls: [server.baseUrl],
                    files: ['config.json'],
                    destDir,
                    attempts: 1,
                }),
                /checksum|corrupt/i,
            );
            assert.ok(!fs.existsSync(path.join(destDir, 'config.json')), 'nothing written on mismatch');
        } finally {
            await server.close();
        }
    });

    test('rejects an HTML block page saved as JSON', async () => {
        const server = await startServer({
            '/config.json': { body: '<html><body>Blocked by proxy</body></html>' },
        });
        try {
            await assert.rejects(
                () => downloadModelFiles({
                    baseUrls: [server.baseUrl],
                    files: ['config.json'],
                    destDir,
                    attempts: 1,
                }),
                /not valid JSON|corrupt/i,
            );
        } finally {
            await server.close();
        }
    });

    test('rejects an ONNX file that is far too small', async () => {
        const server = await startServer({ '/onnx/model.onnx': { body: 'nope' } });
        try {
            await assert.rejects(
                () => downloadModelFiles({
                    baseUrls: [server.baseUrl],
                    files: ['onnx/model.onnx'],
                    destDir,
                    attempts: 1,
                }),
                /corrupt|incomplete/i,
            );
        } finally {
            await server.close();
        }
    });

    test('falls back to the next source when the first one 404s', async () => {
        const empty = await startServer({});
        const working = await startServer({ '/config.json': { body: '{}' } });
        try {
            const result = await downloadModelFiles({
                baseUrls: [empty.baseUrl, working.baseUrl],
                files: ['config.json'],
                destDir,
                attempts: 1,
            });
            assert.strictEqual(result.baseUrl, working.baseUrl);
            assert.ok(fs.existsSync(path.join(destDir, 'config.json')));
        } finally {
            await empty.close();
            await working.close();
        }
    });

    test('keeps what a partial source delivered and fetches only the remainder', async () => {
        // A filter that allows the metadata but blocks the second file.
        const partial = await startServer({ '/config.json': { body: '{"model_type":"bert"}' } });
        const full = await startServer({
            '/config.json': { body: '{"model_type":"bert"}' },
            '/tokenizer.json': { body: '{"version":"1.0"}' },
        });
        try {
            const result = await downloadModelFiles({
                baseUrls: [partial.baseUrl, full.baseUrl],
                files: ['config.json', 'tokenizer.json'],
                destDir,
                attempts: 1,
            });
            assert.strictEqual(result.baseUrl, full.baseUrl);
            assert.ok(fs.existsSync(path.join(destDir, 'config.json')));
            assert.ok(fs.existsSync(path.join(destDir, 'tokenizer.json')));
            assert.ok(
                !full.requests.includes('/config.json'),
                'the file the first source delivered must not be downloaded again',
            );
            assert.ok(full.requests.includes('/tokenizer.json'));
        } finally {
            await partial.close();
            await full.close();
        }
    });

    test('a second call is a no-op once every file is on disk', async () => {
        const server = await startServer({ '/config.json': { body: '{}' } });
        try {
            await downloadModelFiles({
                baseUrls: [server.baseUrl],
                files: ['config.json'],
                destDir,
                attempts: 1,
            });
            server.requests.length = 0;
            const result = await downloadModelFiles({
                baseUrls: [server.baseUrl],
                files: ['config.json'],
                destDir,
                attempts: 1,
            });
            assert.strictEqual(result.bytes, 0);
            assert.deepStrictEqual(server.requests, [], 'nothing may be requested');
        } finally {
            await server.close();
        }
    });

    test('reports every source when all of them fail', async () => {
        const empty = await startServer({});
        try {
            await assert.rejects(
                () => downloadModelFiles({
                    baseUrls: [empty.baseUrl],
                    files: ['config.json'],
                    destDir,
                    attempts: 1,
                }),
                /All model download sources failed/i,
            );
        } finally {
            await empty.close();
        }
    });

    test('no files requested is a no-op', async () => {
        const result = await downloadModelFiles({ baseUrls: [], files: [], destDir });
        assert.deepStrictEqual(result.files, []);
    });

    test('maps a nested onnx/ file onto the flat release asset name', async () => {
        // GitHub releases are flat: the workflow publishes `onnx/model_quantized.onnx`
        // as `model_quantized.onnx` and records the rename in the manifest.
        const onnx = Buffer.alloc(1024 * 1024 + 8, 5);
        const manifest = JSON.stringify({
            version: 1,
            files: {
                'onnx/model_quantized.onnx': {
                    asset: 'model_quantized.onnx',
                    size: onnx.length,
                    sha256: crypto.createHash('sha256').update(onnx).digest('hex'),
                },
            },
        });
        const server = await startServer({
            '/manifest.json': { body: manifest },
            '/model_quantized.onnx': { body: onnx },
        });
        try {
            await downloadModelFiles({
                baseUrls: [server.baseUrl],
                files: ['onnx/model_quantized.onnx'],
                destDir,
                attempts: 1,
            });
            assert.ok(fs.existsSync(path.join(destDir, 'onnx', 'model_quantized.onnx')));
            assert.ok(
                !server.requests.includes('/onnx/model_quantized.onnx'),
                'the flattened asset name must be requested, not the nested path',
            );
        } finally {
            await server.close();
        }
    });

    test('rejects a file whose sha256 does not match the manifest', async () => {
        // Same byte count, different content — only the hash can catch this.
        const body = '{"model_type":"bert"}';
        const manifest = JSON.stringify({
            version: 1,
            files: { 'config.json': { size: Buffer.byteLength(body), sha256: 'deadbeef' } },
        });
        const server = await startServer({
            '/manifest.json': { body: manifest },
            '/config.json': { body },
        });
        try {
            await assert.rejects(
                () => downloadModelFiles({
                    baseUrls: [server.baseUrl],
                    files: ['config.json'],
                    destDir,
                    attempts: 1,
                }),
                /sha256|corrupt/i,
            );
            assert.ok(!fs.existsSync(path.join(destDir, 'config.json')));
        } finally {
            await server.close();
        }
    });

    test('rejects an ONNX sized file that is an HTML page', async () => {
        // A proxy that serves an error page for the weights: big enough to pass
        // the size floor, but the first byte says it is markup, not protobuf.
        const body = Buffer.concat([
            Buffer.from('<html><body>blocked</body></html>'),
            Buffer.alloc(1024 * 1024, 32),
        ]);
        const server = await startServer({ '/onnx/model.onnx': { body } });
        try {
            await assert.rejects(
                () => downloadModelFiles({
                    baseUrls: [server.baseUrl],
                    files: ['onnx/model.onnx'],
                    destDir,
                    attempts: 1,
                }),
                /HTML page|corrupt/i,
            );
            assert.ok(!fs.existsSync(path.join(destDir, 'onnx', 'model.onnx')));
        } finally {
            await server.close();
        }
    });

    test('treats an unparseable manifest as absent', async () => {
        const server = await startServer({
            '/manifest.json': { body: '{not json' },
            '/config.json': { body: '{"model_type":"bert"}' },
        });
        try {
            const result = await downloadModelFiles({
                baseUrls: [server.baseUrl],
                files: ['config.json'],
                destDir,
                attempts: 1,
            });
            assert.strictEqual(result.baseUrl, server.baseUrl);
            assert.ok(fs.existsSync(path.join(destDir, 'config.json')));
        } finally {
            await server.close();
        }
    });

    test('treats a manifest without a files map as absent', async () => {
        const server = await startServer({
            '/manifest.json': { body: '{"version":1}' },
            '/config.json': { body: '{"model_type":"bert"}' },
        });
        try {
            await downloadModelFiles({
                baseUrls: [server.baseUrl],
                files: ['config.json'],
                destDir,
                attempts: 1,
            });
            assert.ok(fs.existsSync(path.join(destDir, 'config.json')));
        } finally {
            await server.close();
        }
    });

    test('skips blank sources instead of treating them as a failure', async () => {
        const server = await startServer({ '/config.json': { body: '{}' } });
        try {
            const result = await downloadModelFiles({
                baseUrls: ['   ', '', server.baseUrl],
                files: ['config.json'],
                destDir,
                attempts: 1,
            });
            assert.strictEqual(result.baseUrl, server.baseUrl);
        } finally {
            await server.close();
        }
    });

    test('streams progress and diagnostics while falling back to a second source', async () => {
        const partial = await startServer({ '/config.json': { body: '{"model_type":"bert"}' } });
        const full = await startServer({
            '/config.json': { body: '{"model_type":"bert"}' },
            '/tokenizer.json': { body: '{"version":"1.0"}' },
        });
        const progress: string[] = [];
        const log: string[] = [];
        try {
            const result = await downloadModelFiles({
                baseUrls: [partial.baseUrl, full.baseUrl],
                files: ['config.json', 'tokenizer.json'],
                destDir,
                attempts: 1,
                onProgress: message => progress.push(message),
                onLog: message => log.push(message),
            });
            assert.strictEqual(result.baseUrl, full.baseUrl);
            assert.ok(
                log.some(line => /1 file\(s\) already on disk/.test(line)),
                `expected a partial-source note, got:\n${log.join('\n')}`,
            );
            assert.ok(
                log.some(line => /No manifest\.json/.test(line)),
                `expected a manifest note, got:\n${log.join('\n')}`,
            );
            assert.ok(
                log.some(line => /✗ .* failed:/.test(line)),
                `expected the failed source to be logged, got:\n${log.join('\n')}`,
            );
            assert.ok(
                progress.some(line => /Downloading tokenizer\.json \(1\/1\): 100%/.test(line)),
                `expected byte progress, got:\n${progress.join('\n')}`,
            );
            assert.ok(progress.some(line => /Source unavailable/.test(line)));
        } finally {
            await partial.close();
            await full.close();
        }
    });
});

suite('modelDownloader helpers', () => {
    test('normalizeBaseUrl adds the trailing slash new URL() needs', () => {
        assert.strictEqual(normalizeBaseUrl('https://x/y'), 'https://x/y/');
        assert.strictEqual(normalizeBaseUrl('https://x/y/'), 'https://x/y/');
        assert.strictEqual(normalizeBaseUrl('  '), '');
        // A caller may hand over an unset setting rather than an empty string.
        assert.strictEqual(normalizeBaseUrl(undefined as unknown as string), '');
    });

    test('encodeRelativePath keeps separators but encodes segments', () => {
        assert.strictEqual(encodeRelativePath('onnx/model onnx.onnx'), 'onnx/model%20onnx.onnx');
        assert.strictEqual(encodeRelativePath('/a//b.json'), 'a/b.json');
    });

    test('shouldBypassProxy honours NO_PROXY entries', () => {
        const saved = process.env['NO_PROXY'];
        try {
            process.env['NO_PROXY'] = 'localhost, .corp.example, 10.0.0.5:8080';
            assert.strictEqual(shouldBypassProxy('localhost'), true);
            assert.strictEqual(shouldBypassProxy('api.corp.example'), true);
            assert.strictEqual(shouldBypassProxy('huggingface.co'), false);
            process.env['NO_PROXY'] = '*';
            assert.strictEqual(shouldBypassProxy('huggingface.co'), true);
        } finally {
            if (saved === undefined) {
                delete process.env['NO_PROXY'];
            } else {
                process.env['NO_PROXY'] = saved;
            }
        }
    });

    test('shouldBypassProxy reads no_proxy too and ignores blank input', () => {
        const savedUpper = process.env['NO_PROXY'];
        const savedLower = process.env['no_proxy'];
        try {
            // Nothing configured at all, and no hostname to compare.
            delete process.env['NO_PROXY'];
            delete process.env['no_proxy'];
            assert.strictEqual(shouldBypassProxy('huggingface.co'), false);
            assert.strictEqual(shouldBypassProxy(''), false);

            // Lowercase spelling is honoured and matches subdomains.
            process.env['no_proxy'] = 'internal.example';
            assert.strictEqual(shouldBypassProxy('internal.example'), true);
            assert.strictEqual(shouldBypassProxy('git.internal.example'), true);
            assert.strictEqual(shouldBypassProxy('notinternal.example'), false);
        } finally {
            restoreEnv('NO_PROXY', savedUpper);
            restoreEnv('no_proxy', savedLower);
        }
    });
});

suite('modelDownloader.resolveProxy', () => {
    const ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'] as const;
    const saved: Record<string, string | undefined> = {};

    setup(() => {
        for (const key of ENV_KEYS) {
            saved[key] = process.env[key];
            delete process.env[key];
        }
    });

    teardown(() => {
        for (const key of ENV_KEYS) {
            restoreEnv(key, saved[key]);
        }
    });

    test('returns undefined when nothing is configured', () => {
        assert.strictEqual(resolveProxy(undefined), undefined);
        assert.strictEqual(resolveProxy('   '), undefined);
    });

    test('adds a scheme to a bare host:port value', () => {
        const proxy = resolveProxy('proxy.corp:8080');
        assert.strictEqual(proxy?.protocol, 'http:');
        assert.strictEqual(proxy?.hostname, 'proxy.corp');
        assert.strictEqual(proxy?.port, '8080');
    });

    test('keeps an explicit scheme', () => {
        const proxy = resolveProxy('https://proxy.corp:8443');
        assert.strictEqual(proxy?.protocol, 'https:');
        assert.strictEqual(proxy?.hostname, 'proxy.corp');
    });

    test('falls back to the proxy environment variables in order', () => {
        process.env['http_proxy'] = 'http://lower-http.corp:81';
        assert.strictEqual(resolveProxy(undefined)?.hostname, 'lower-http.corp');
        process.env['HTTP_PROXY'] = 'http://upper-http.corp:82';
        assert.strictEqual(resolveProxy(undefined)?.hostname, 'upper-http.corp');
        process.env['https_proxy'] = 'http://lower-https.corp:83';
        assert.strictEqual(resolveProxy(undefined)?.hostname, 'lower-https.corp');
        process.env['HTTPS_PROXY'] = 'http://upper-https.corp:84';
        assert.strictEqual(resolveProxy(undefined)?.hostname, 'upper-https.corp');
    });

    test('an explicit proxy wins over the environment', () => {
        process.env['HTTPS_PROXY'] = 'http://env.corp:8080';
        assert.strictEqual(resolveProxy('http://explicit.corp:3128')?.hostname, 'explicit.corp');
    });

    test('NO_PROXY bypasses the proxy for matching targets', () => {
        process.env['HTTPS_PROXY'] = 'http://env.corp:8080';
        process.env['NO_PROXY'] = '.huggingface.co';
        assert.strictEqual(resolveProxy(undefined, 'https://huggingface.co/x'), undefined);
        assert.strictEqual(resolveProxy(undefined, 'https://example.com/x')?.hostname, 'env.corp');
    });

    test('an unusable proxy value is ignored instead of thrown', () => {
        // Unparseable (unbalanced IPv6 bracket) and host-less values both fall
        // back to "no proxy" rather than breaking the download.
        assert.strictEqual(resolveProxy('http://[::1'), undefined);
        assert.strictEqual(resolveProxy('file:///tmp/proxy.sock'), undefined);
    });
});
