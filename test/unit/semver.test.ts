/**
 * test/unit/semver.test.ts
 *
 * Unit tests for semver.ts — pure version comparison function.
 */

import * as assert from 'assert';
import { isNewerVersion } from '../../src/utils/semver';

suite('semver', () => {
    suite('isNewerVersion', () => {
        test('returns true when candidate major is higher', () => {
            assert.strictEqual(isNewerVersion('2.0.0', '1.9.9'), true);
        });

        test('returns false when candidate major is lower', () => {
            assert.strictEqual(isNewerVersion('1.0.0', '2.0.0'), false);
        });

        test('returns true when candidate minor is higher (same major)', () => {
            assert.strictEqual(isNewerVersion('1.3.0', '1.2.9'), true);
        });

        test('returns false when candidate minor is lower (same major)', () => {
            assert.strictEqual(isNewerVersion('1.1.0', '1.2.0'), false);
        });

        test('returns true when candidate patch is higher (same major.minor)', () => {
            assert.strictEqual(isNewerVersion('1.2.5', '1.2.4'), true);
        });

        test('returns false when candidate patch is lower (same major.minor)', () => {
            assert.strictEqual(isNewerVersion('1.2.3', '1.2.4'), false);
        });

        test('returns false when versions are equal', () => {
            assert.strictEqual(isNewerVersion('1.2.3', '1.2.3'), false);
        });

        test('handles single-digit versions', () => {
            assert.strictEqual(isNewerVersion('2', '1'), true);
            assert.strictEqual(isNewerVersion('1', '2'), false);
            assert.strictEqual(isNewerVersion('1', '1'), false);
        });

        test('handles two-part versions (major.minor)', () => {
            assert.strictEqual(isNewerVersion('1.3', '1.2'), true);
            assert.strictEqual(isNewerVersion('1.2', '1.3'), false);
            assert.strictEqual(isNewerVersion('1.2', '1.2'), false);
        });

        test('ignores extra pre-release segments beyond patch', () => {
            assert.strictEqual(isNewerVersion('1.2.3-beta.1', '1.2.3-alpha'), false);
            assert.strictEqual(isNewerVersion('1.2.3', '1.2.3-beta'), true);
        });

        test('handles empty/default segments as zero', () => {
            // Candidate has more digits than current
            assert.strictEqual(isNewerVersion('1.2.3', '1.2'), true);
            // Current has more digits than candidate
            assert.strictEqual(isNewerVersion('1.2', '1.2.3'), false);
        });

        test('pre-release candidate is not newer than same release version', () => {
            assert.strictEqual(isNewerVersion('1.0.0-alpha', '1.0.0'), false);
        });

        test('release candidate is newer than same pre-release version', () => {
            assert.strictEqual(isNewerVersion('1.0.0', '1.0.0-beta'), true);
        });

        test('pre-release vs pre-release compares by numeric parts only', () => {
            assert.strictEqual(isNewerVersion('1.0.0-beta', '1.0.0-alpha'), false);
        });

        test('handles version with leading zeros in parts', () => {
            assert.strictEqual(isNewerVersion('1.02.0', '1.01.0'), true);
        });

        test('handles non-numeric pre-release tags gracefully', () => {
            assert.strictEqual(isNewerVersion('1.0.0-rc.1', '1.0.0-beta.2'), false);
        });
    });
});