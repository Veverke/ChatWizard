/**
 * test/unit/mockLmApi.ts
 *
 * Shared mock helper for VS Code LM API.
 * Stubs vscode.lm.selectChatModels and vscode.workspace.getConfiguration
 * so that promptLlm() and its callers return controlled responses.
 *
 * Usage:
 *   const mock = setupMockLmApi({ responseText: '{"frameworks":["React"]}' });
 *   // ... run tests ...
 *   mock.restore();
 */

import * as sinon from 'sinon';
import * as vscode from 'vscode';

export interface MockLmApi {
    /** Stub on vscode.lm.selectChatModels */
    selectChatModels: sinon.SinonStub;
    /** Stub on the mock model's sendRequest */
    sendRequest: sinon.SinonStub;
    /** Stub on vscode.workspace.getConfiguration */
    getConfig: sinon.SinonStub;
    /** Restore all stubs */
    restore(): void;
}

export interface MockLmApiOptions {
    /** Whether a model is available. Default: true */
    modelAvailable?: boolean;
    /** Text returned by the mock model's sendRequest. Default: 'mock response' */
    responseText?: string;
    /** Value of chatwizard.llmProvider setting. Default: 'auto' */
    configProvider?: string;
    /** Number of models to return. Default: 1 */
    modelCount?: number;
}

/**
 * Set up stubs for the VS Code LM API.
 * Call `mock.restore()` in a teardown hook (afterEach / suiteTeardown).
 */
export function setupMockLmApi(options?: MockLmApiOptions): MockLmApi {
    const opts = {
        modelAvailable: true,
        responseText: 'mock response',
        configProvider: 'auto',
        modelCount: 1,
        ...options,
    };

    // Build an async iterable that yields the response text
    const asyncIterable = {
        [Symbol.asyncIterator]: async function* (): AsyncGenerator<string> {
            yield opts.responseText;
        },
    };

    const sendRequest = sinon.stub().resolves({ text: asyncIterable });

    const models = opts.modelAvailable
        ? Array.from({ length: opts.modelCount }, (_, i) => ({
            name: `mock-model-${i}`,
            family: 'gpt-4o-mini',
            vendor: 'copilot',
            sendRequest,
        } as unknown as vscode.LanguageModelChat))
        : [];

    const selectChatModels = sinon.stub(vscode.lm, 'selectChatModels');
    selectChatModels.resolves(models);

    const configGet = sinon.stub();
    configGet.withArgs('llmProvider', 'auto').returns(opts.configProvider);
    configGet.returns(undefined);

    const getConfig = sinon.stub(vscode.workspace, 'getConfiguration');
    getConfig.withArgs('chatwizard').returns({ get: configGet } as unknown as vscode.WorkspaceConfiguration);
    getConfig.returns({ get: sinon.stub() } as unknown as vscode.WorkspaceConfiguration);

    return {
        selectChatModels,
        sendRequest,
        getConfig,
        restore: () => {
            selectChatModels.restore();
            getConfig.restore();
        },
    };
}

/**
 * Create a minimal Session object for testing.
 */
import type { Session, Message } from '../../src/types/index';

export function msg(role: 'user' | 'assistant', content: string): Message {
    return { id: `m-${Math.random()}`, role, content, codeBlocks: [] };
}

export function makeSession(overrides: Partial<Session> & { id: string }): Session {
    return {
        id: overrides.id,
        source: 'copilot',
        title: overrides.title ?? 'Test session',
        messages: overrides.messages ?? [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        workspaceId: 'ws',
        workspacePath: '/ws',
        filePath: `/ws/${overrides.id}.jsonl`,
    };
}