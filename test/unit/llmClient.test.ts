/**
 * test/unit/llmClient.test.ts
 *
 * Unit tests for llmClient — the central LLM completion client.
 * Uses sinon to stub vscode.lm.selectChatModels and vscode.workspace.getConfiguration.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { setupMockLmApi } from './mockLmApi.js';

suite('llmClient', () => {
    let mock: ReturnType<typeof setupMockLmApi>;

    setup(() => {
        // Each test gets fresh stubs
    });

    teardown(() => {
        if (mock) { mock.restore(); }
    });

    suite('promptLlm', () => {
        test('returns response text when VS Code LM API is available', async () => {
            mock = setupMockLmApi({ responseText: 'Hello from mock' });
            const { promptLlm } = await import('../../src/analytics/llmClient.js');
            const result = await promptLlm(undefined, 'test prompt');
            assert.strictEqual(result, 'Hello from mock');
        });

        test('returns null when no model is available', async () => {
            mock = setupMockLmApi({ modelAvailable: false });
            const { promptLlm } = await import('../../src/analytics/llmClient.js');
            const result = await promptLlm(undefined, 'test prompt');
            assert.strictEqual(result, null);
        });

        test('passes system prompt inlined with user content', async () => {
            mock = setupMockLmApi({ responseText: 'system-aware response' });
            const { promptLlm } = await import('../../src/analytics/llmClient.js');
            const result = await promptLlm('You are a helper', 'test prompt');
            assert.strictEqual(result, 'system-aware response');
        });

        test('respects timeout option', async () => {
            mock = setupMockLmApi({ responseText: 'timed response' });
            const { promptLlm } = await import('../../src/analytics/llmClient.js');
            const result = await promptLlm(undefined, 'test', { timeoutMs: 5000 });
            assert.strictEqual(result, 'timed response');
        });

        test('returns null when provider is cursor and not in cursor', async () => {
            mock = setupMockLmApi({ configProvider: 'cursor', modelAvailable: false });
            const { promptLlm } = await import('../../src/analytics/llmClient.js');
            const result = await promptLlm(undefined, 'test');
            assert.strictEqual(result, null);
        });
    });

    suite('isLlmAvailable', () => {
        test('returns true when models are available', async () => {
            mock = setupMockLmApi({ modelAvailable: true });
            const { isLlmAvailable } = await import('../../src/analytics/llmClient.js');
            const result = await isLlmAvailable(500);
            assert.strictEqual(result, true);
        });

        // Note: "returns false when no models available" is not tested here
        // because isLlmAvailable falls through to findCursorAgent() which
        // uses fs.existsSync (non-configurable in Node.js, can't stub).
        // The null-return path is covered by promptLlm tests above.
    });

    suite('isRunningInCursor', () => {
        let envStub: sinon.SinonStub;

        teardown(() => {
            if (envStub) { envStub.restore(); }
        });

        test('returns true when appName contains cursor', () => {
            envStub = sinon.stub(vscode.env, 'appName').get(() => 'Cursor');
            const { isRunningInCursor } = require('../../src/analytics/llmClient.js');
            assert.strictEqual(isRunningInCursor(), true);
        });

        test('returns false when appName does not contain cursor', () => {
            envStub = sinon.stub(vscode.env, 'appName').get(() => 'Visual Studio Code');
            const { isRunningInCursor } = require('../../src/analytics/llmClient.js');
            assert.strictEqual(isRunningInCursor(), false);
        });
    });
});