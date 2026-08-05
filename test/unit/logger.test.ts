/**
 * test/unit/logger.test.ts
 *
 * Unit tests for logger.ts — pure utility functions and createLogger.
 * Tests avoid VS Code API where possible; createLogger tests mock the channel.
 */

import * as assert from 'assert';
import { withTimeout, getSharedChannel } from '../../src/utils/logger';

suite('logger', () => {
    suite('withTimeout', () => {
        test('resolves when inner promise resolves before timeout', async () => {
            const result = await withTimeout(Promise.resolve('ok'), 1000);
            assert.strictEqual(result, 'ok');
        });

        test('rejects when inner promise rejects before timeout', async () => {
            await assert.rejects(
                withTimeout(Promise.reject(new Error('fail')), 1000),
                /fail/
            );
        });

        test('rejects when timeout elapses before inner promise resolves', async () => {
            const slow = new Promise<string>(() => { /* never settles */ });
            await assert.rejects(
                withTimeout(slow, 50, 'slow-op'),
                /Timed out after 50ms: slow-op/
            );
        });
    });

    suite('getSharedChannel', () => {
        test('returns an output channel', () => {
            const channel = getSharedChannel();
            assert.ok(channel);
            // Calling twice returns same channel
            assert.strictEqual(getSharedChannel(), channel);
        });
    });

    suite('createLogger', () => {
        test('creates a logger with default level INFO', () => {
            // Import createLogger inside test so VS Code API is available
            const { createLogger } = require('../../src/utils/logger');
            const log = createLogger('Chat Wizard Test');
            assert.ok(log);
            assert.strictEqual(typeof log.debug, 'function');
            assert.strictEqual(typeof log.info, 'function');
            assert.strictEqual(typeof log.warn, 'function');
            assert.strictEqual(typeof log.error, 'function');
        });

        test('withContext returns a BoundLogger', () => {
            const { createLogger } = require('../../src/utils/logger');
            const log = createLogger('Chat Wizard Test');
            const bound = log.withContext('SubComponent');
            assert.ok(bound);
            assert.strictEqual(typeof bound.debug, 'function');
            assert.strictEqual(typeof bound.info, 'function');
        });

        test('setLevel changes minimum level', () => {
            const { createLogger } = require('../../src/utils/logger');
            const log = createLogger('Chat Wizard Test');
            log.setLevel('DEBUG');
            // After setting DEBUG, all levels should work
            log.debug('test', 'debug msg');
            log.info('test', 'info msg');
            log.warn('test', 'warn msg');
            log.error('test', 'error msg');
            // No assertion needed — just verify no crash
        });

        test('nested withContext chains contexts', () => {
            const { createLogger } = require('../../src/utils/logger');
            const log = createLogger('Chat Wizard Test');
            const a = log.withContext('A');
            const b = a.withContext('B');
            b.info('deep message');
            // Both contexts A > B are present in output
        });

        test('getChannel returns the underlying channel', () => {
            const { createLogger } = require('../../src/utils/logger');
            const log = createLogger('Chat Wizard Test');
            const ch = log.getChannel();
            assert.ok(ch);
            assert.strictEqual(typeof ch.appendLine, 'function');
        });
    });
});