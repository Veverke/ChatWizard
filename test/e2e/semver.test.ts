// test/suite/semver.test.ts
//
// Unit tests for the isNewerVersion() semver comparison utility.
//
// Bugs these tests would catch:
//   Bug: Comparing patch version numerically (10 > 9) but treating as string ('10' < '9').
//   Bug: Off-by-one: returning true when versions are equal.
//   Bug: Ignoring major/minor when lower segment differs.

import * as assert from 'assert';
import { isNewerVersion } from '../../src/utils/semver';

suite('isNewerVersion', () => {

    // ── Strictly newer: should return true ─────────────────────────────────

    test('newer major: 2.0.0 > 1.9.9', () => {
        assert.strictEqual(isNewerVersion('2.0.0', '1.9.9'), true);
    });

    test('newer minor: 1.4.0 > 1.3.0', () => {
        assert.strictEqual(isNewerVersion('1.4.0', '1.3.0'), true);
    });

    test('newer patch: 1.3.1 > 1.3.0', () => {
        assert.strictEqual(isNewerVersion('1.3.1', '1.3.0'), true);
    });

    test('large patch delta: 1.3.10 > 1.3.9 (numeric not lexicographic)', () => {
        assert.strictEqual(isNewerVersion('1.3.10', '1.3.9'), true);
    });

    test('large minor delta: 1.10.0 > 1.9.0 (numeric not lexicographic)', () => {
        assert.strictEqual(isNewerVersion('1.10.0', '1.9.0'), true);
    });

    // ── Not newer: should return false ──────────────────────────────────────

    test('same version: 1.3.0 === 1.3.0', () => {
        assert.strictEqual(isNewerVersion('1.3.0', '1.3.0'), false);
    });

    test('older major: 1.9.9 < 2.0.0', () => {
        assert.strictEqual(isNewerVersion('1.9.9', '2.0.0'), false);
    });

    test('older minor: 1.3.0 < 1.4.0', () => {
        assert.strictEqual(isNewerVersion('1.3.0', '1.4.0'), false);
    });

    test('older patch: 1.3.0 < 1.3.1', () => {
        assert.strictEqual(isNewerVersion('1.3.0', '1.3.1'), false);
    });

    // ── Edge cases ──────────────────────────────────────────────────────────

    test('handles missing patch segment: 1.4 vs 1.3.0', () => {
        assert.strictEqual(isNewerVersion('1.4', '1.3.0'), true);
    });

    test('handles missing patch and minor: 2 vs 1.0.0', () => {
        assert.strictEqual(isNewerVersion('2', '1.0.0'), true);
    });

    test('does not confuse minor increase with major: 1.4.0 not > 2.0.0', () => {
        assert.strictEqual(isNewerVersion('1.4.0', '2.0.0'), false);
    });

    test('major increase ignores lower segments: 2.0.0 > 1.99.99', () => {
        assert.strictEqual(isNewerVersion('2.0.0', '1.99.99'), true);
    });

    test('equal major/minor/patch with extra suffix ignored: 1.4.0-beta vs 1.4.0', () => {
        // parseInt stops at non-digit, so '0-beta' parses as 0 — same patch
        assert.strictEqual(isNewerVersion('1.4.0-beta', '1.4.0'), false);
    });
});
