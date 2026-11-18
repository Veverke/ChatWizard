// test/unit/semanticModelInstaller.test.ts
// Unit tests for model provisioning: source ordering, local folders, downloads.

import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import {
    SemanticModelInstaller,
    buildBaseUrls,
    hostLabel,
    type SemanticModelSourceOptions,
} from '../../src/search/semanticModelInstaller';
import { SEMANTIC_MODEL_ID, SEMANTIC_MODEL_ORG } from '../../src/search/localModelPath';

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

async function startModelServer(): Promise<TestServer> {
    const onnx = Buffer.alloc(1024 * 1024 + 16, 7);
    const files: Record<string, string | Buffer> = {
        '/config.json': '{"model_type":"bert"}',
        '/tokenizer.json': '{"version":"1.0"}',
        '/tokenizer_config.json': '{}',
        '/onnx/model_quantized.onnx': onnx,
    };
    const server = http.createServer((req, res) => {
        const body = files[req.url ?? '/'];
        if (!body) {
            res.statusCode = 404;
            res.end('not found');
            return;
        }
        const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
        res.setHeader('content-length', String(buffer.length));
        res.end(buffer);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return {
        baseUrl: `http://127.0.0.1:${port}/`,
        close: () => new Promise<void>((resolve, reject) => {
            server.close(err => (err ? reject(err) : resolve()));
        }),
    };
}

suite('semanticModelInstaller.buildBaseUrls', () => {
    test('defaults to the official Hub plus the GitHub asset', () => {
        const urls = buildBaseUrls({ fallbackBaseUrl: 'https://github.com/x/y/releases/download/t/' });
        assert.strictEqual(urls.length, 2);
        assert.ok(urls[0].startsWith('https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/'));
        assert.strictEqual(urls[1], 'https://github.com/x/y/releases/download/t/');
    });

    test('puts a configured mirror first', () => {
        const urls = buildBaseUrls({
            mirrorHost: 'https://hf-mirror.com/',
            fallbackBaseUrl: 'https://github.com/x/y/releases/download/t',
        });
        assert.strictEqual(urls[0], 'https://hf-mirror.com/Xenova/all-MiniLM-L6-v2/resolve/main/');
        assert.strictEqual(urls[2], 'https://github.com/x/y/releases/download/t/');
    });

    test('an explicit source list replaces the defaults', () => {
        const urls = buildBaseUrls({ baseUrls: ['http://localhost:1234/models/'] });
        assert.deepStrictEqual(urls, ['http://localhost:1234/models/']);
    });

    test('honours HF_ENDPOINT as the mirror and normalizes revisions', () => {
        const savedEndpoint = process.env['HF_ENDPOINT'];
        try {
            process.env['HF_ENDPOINT'] = 'https://hf.internal/';
            const mirrored = buildBaseUrls({ fallbackBaseUrl: 'https://github.com/x/y/releases/download/t/' });
            assert.strictEqual(mirrored[0], 'https://hf.internal/Xenova/all-MiniLM-L6-v2/resolve/main/');

            delete process.env['HF_ENDPOINT'];
            // A pinned revision is trimmed and the repo path loses its slashes.
            const pinned = buildBaseUrls({ revision: '  v1.2  ', repoPath: '/custom/repo/' });
            assert.strictEqual(pinned[0], 'https://huggingface.co/custom/repo/resolve/v1.2/');

            // A blank revision means "main" rather than an empty URL segment.
            const blank = buildBaseUrls({ revision: '   ' });
            assert.ok(blank[0].includes('/resolve/main/'), blank[0]);
        } finally {
            if (savedEndpoint === undefined) {
                delete process.env['HF_ENDPOINT'];
            } else {
                process.env['HF_ENDPOINT'] = savedEndpoint;
            }
        }
    });

    test('a blank mirror host does not produce a source', () => {
        const urls = buildBaseUrls({ mirrorHost: '   ', fallbackBaseUrl: '' });
        assert.deepStrictEqual(urls, ['https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/']);
    });

    test('hostLabel returns the host, or the input when unparseable', () => {
        assert.strictEqual(hostLabel('https://huggingface.co/a/b/'), 'huggingface.co');
        assert.strictEqual(hostLabel('not a url'), 'not a url');
        // No host at all (file: URL) and no value at all both stay readable.
        assert.strictEqual(hostLabel('file:///tmp/model/'), 'file:///tmp/model/');
        assert.strictEqual(hostLabel(''), 'unknown');
    });
});

suite('semanticModelInstaller.ensureModel', () => {
    let storageDir: string;
    const savedEnv: Record<string, string | undefined> = {};
    const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const;

    setup(() => {
        // Keep loopback downloads off any proxy configured on the machine.
        for (const key of PROXY_VARS) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
        storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-installer-'));
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
        fs.rmSync(storageDir, { recursive: true, force: true });
    });

    test('uses an explicit local folder without any network access', async () => {
        const localRoot = path.join(storageDir, 'local');
        const modelDir = path.join(localRoot, SEMANTIC_MODEL_ORG, SEMANTIC_MODEL_ID);
        fs.mkdirSync(path.join(modelDir, 'onnx'), { recursive: true });
        fs.writeFileSync(path.join(modelDir, 'config.json'), '{}');
        fs.writeFileSync(path.join(modelDir, 'tokenizer.json'), '{}');
        fs.writeFileSync(path.join(modelDir, 'onnx', 'model_quantized.onnx'), 'x');

        const installer = new SemanticModelInstaller(
            path.join(storageDir, 'cache'),
            () => ({ localModelPath: localRoot }),
        );
        const installed = await installer.ensureModel();
        assert.strictEqual(installed.source, 'local-folder');
        assert.strictEqual(installed.downloaded, false);
        assert.strictEqual(installed.folder, modelDir);
    });

    test('reports an incomplete local folder', async () => {
        const localRoot = path.join(storageDir, 'local');
        fs.mkdirSync(localRoot, { recursive: true });
        fs.writeFileSync(path.join(localRoot, 'config.json'), '{}');

        const installer = new SemanticModelInstaller(
            path.join(storageDir, 'cache'),
            () => ({ localModelPath: localRoot }),
        );
        await assert.rejects(() => installer.ensureModel(), /incomplete/i);
    });

    test('downloads into its own folder and reuses it afterwards', async () => {
        const server = await startModelServer();
        try {
            const options: SemanticModelSourceOptions = { baseUrls: [server.baseUrl] };
            const installer = new SemanticModelInstaller(path.join(storageDir, 'cache'), () => options);

            assert.strictEqual(installer.isModelPresent(), false);
            const progress: string[] = [];
            const installed = await installer.ensureModel(message => progress.push(message));
            assert.strictEqual(installed.downloaded, true);
            assert.strictEqual(installed.source.startsWith('127.0.0.1'), true, `unexpected source ${installed.source}`);
            assert.ok(fs.existsSync(path.join(installed.folder, 'onnx', 'model_quantized.onnx')));
            assert.strictEqual(installer.isModelPresent(), true);
            assert.ok(
                progress.some(message => /Fetching the AI model from 127\.0\.0\.1/.test(message)),
                `expected a download notice, got:\n${progress.join('\n')}`,
            );

            const reused = await installer.ensureModel();
            assert.strictEqual(reused.source, 'cache');
            assert.strictEqual(reused.downloaded, false);
        } finally {
            await server.close();
        }
    });

    test('reuses a model left by an earlier cache layout', async () => {
        // transformers.js used to cache under <root>/huggingface.co/<org>/<id>/resolve/<rev>;
        // an upgraded install must keep that 23 MB instead of downloading it again.
        const legacy = path.join(
            storageDir, 'huggingface.co', SEMANTIC_MODEL_ORG, SEMANTIC_MODEL_ID, 'resolve', 'main',
        );
        fs.mkdirSync(path.join(legacy, 'onnx'), { recursive: true });
        fs.writeFileSync(path.join(legacy, 'config.json'), '{}');
        fs.writeFileSync(path.join(legacy, 'tokenizer.json'), '{}');
        fs.writeFileSync(path.join(legacy, 'onnx', 'model_quantized.onnx'), 'x');

        const logs: string[] = [];
        const installer = new SemanticModelInstaller(
            path.join(storageDir, 'cache'),
            () => ({
                mirrorHost: 'https://hf-mirror.com',
                fallbackBaseUrl: 'https://github.com/x/y/releases/download/t',
            }),
            {
                info: (message: string) => logs.push(message),
                warn: (message: string) => logs.push(message),
                error: (message: string) => logs.push(message),
            },
        );

        const installed = await installer.ensureModel();
        assert.strictEqual(installed.folder, legacy);
        assert.strictEqual(installed.source, 'cache');
        assert.strictEqual(installed.downloaded, false);
        assert.ok(logs.some(line => /Reusing a model/.test(line)), logs.join('\n'));
        // The configured mirror and fallback are reported so a bug report shows them.
        assert.ok(logs.some(line => /mirror: https:\/\/hf-mirror\.com/.test(line)), logs.join('\n'));
        assert.ok(logs.some(line => /fallback: https:\/\/github\.com/.test(line)), logs.join('\n'));
    });
});
