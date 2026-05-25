// test/e2e/modelPriceTable.test.ts
import * as assert from 'assert';
import { resolveModelId } from '../../src/utils/modelPriceTable';

suite('modelPriceTable', () => {

    suite('resolveModelId', () => {

        test('resolves exact model id', () => {
            assert.strictEqual(resolveModelId('gpt-4o'), 'gpt-4o');
        });

        test('resolves case-insensitive alias', () => {
            assert.strictEqual(resolveModelId('GPT-4O'), 'gpt-4o');
        });

        test('resolves claude alias', () => {
            assert.strictEqual(resolveModelId('claude-3.5-sonnet'), 'claude-3-5-sonnet');
        });

        test('resolves claude-sonnet short alias', () => {
            assert.strictEqual(resolveModelId('claude-sonnet'), 'claude-3-5-sonnet');
        });

        test('resolves gemini alias', () => {
            assert.strictEqual(resolveModelId('gemini-2.0-flash'), 'gemini-2.0-flash');
        });

        test('returns undefined for unknown model', () => {
            assert.strictEqual(resolveModelId('unknown-model-xyz'), undefined);
        });

    });

});
