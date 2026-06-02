import * as assert from 'assert';
import { loadUiState, saveUiState, PersistedUiState } from '../../src/utils/persistedUiState';

/** Minimal ExtensionContext stub that stores one key in memory. */
function makeCtx(initial?: string) {
    const store = new Map<string, unknown>();
    if (initial !== undefined) {
        store.set('chatwizard.uiState', initial);
    }
    return {
        globalState: {
            get<T>(key: string): T | undefined { return store.get(key) as T | undefined; },
            update(key: string, value: unknown): Thenable<void> {
                store.set(key, value);
                return Promise.resolve();
            },
        },
    } as unknown as import('vscode').ExtensionContext;
}

suite('persistedUiState', () => {
    test('returns defaults when no persisted state exists', () => {
        const ctx = makeCtx();
        const state = loadUiState(ctx);
        assert.deepStrictEqual(state.sortStack, [{ key: 'date', direction: 'desc' }]);
        assert.deepStrictEqual(state.pinnedIds, []);
        assert.deepStrictEqual(state.manualOrder, []);
        assert.strictEqual(state.sessionGroupMode, 'date');
        assert.strictEqual(state.cbGroupMode, 'language');
    });

    test('round-trips a full state object', () => {
        const ctx = makeCtx();
        const toSave: PersistedUiState = {
            sortStack: [{ key: 'title', direction: 'asc' }],
            pinnedIds: ['id1', 'id2'],
            manualOrder: ['id2', 'id1'],
            sessionGroupMode: 'branch',
            cbGroupMode: 'none',
        };
        saveUiState(ctx, toSave);
        const loaded = loadUiState(ctx);
        assert.deepStrictEqual(loaded, toSave);
    });

    test('falls back to defaults on corrupt JSON', () => {
        const ctx = makeCtx('not-valid-json{{{');
        const state = loadUiState(ctx);
        assert.deepStrictEqual(state.sortStack, [{ key: 'date', direction: 'desc' }]);
    });

    test('falls back to defaults for partial state (empty sortStack)', () => {
        const ctx = makeCtx(JSON.stringify({ sortStack: [], pinnedIds: ['x'] }));
        const state = loadUiState(ctx);
        // sortStack empty → use default
        assert.deepStrictEqual(state.sortStack, [{ key: 'date', direction: 'desc' }]);
        // pinnedIds preserved
        assert.deepStrictEqual(state.pinnedIds, ['x']);
    });

    test('saveUiState issues exactly one globalState.update call', () => {
        let callCount = 0;
        const ctx = {
            globalState: {
                get: () => undefined,
                update(_key: string, _val: unknown) { callCount++; return Promise.resolve(); },
            },
        } as unknown as import('vscode').ExtensionContext;

        const state: PersistedUiState = {
            sortStack: [{ key: 'date', direction: 'desc' }],
            pinnedIds: [],
            manualOrder: [],
            sessionGroupMode: 'none',
            cbGroupMode: 'language',
        };
        saveUiState(ctx, state);
        assert.strictEqual(callCount, 1);
    });
});