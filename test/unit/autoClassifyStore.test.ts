/**
 * test/unit/autoClassifyStore.test.ts
 *
 * The arranger's own run state (fingerprint, settings, amendments).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AutoClassifyStore, AUTO_CLASSIFY_STATE_VERSION } from '../../src/analytics/autoClassifyStore';
import type { AutoClassifyState } from '../../src/analytics/autoClassifyStore';
import { emptyAmendments } from '../../src/analytics/autoTreeReconciler';

function tmpDir(): string {
    const dir = path.join(os.tmpdir(), `cw-acstore-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function makeState(): AutoClassifyState {
    return {
        version: AUTO_CLASSIFY_STATE_VERSION,
        lastRunAt: '2024-01-01T00:00:00Z',
        fingerprint: '3:abc',
        sessionCount: 3,
        categoryCount: 3,
        maxDepth: 3,
        usedLlm: true,
        categories: [{ name: 'Git', sessionCount: 3, subcategoryCount: 1 }],
        amendments: emptyAmendments(),
        classificationRevision: 2,
    };
}

suite('AutoClassifyStore', () => {
    let dir: string;

    setup(() => { dir = tmpDir(); });
    teardown(() => {
        try { fs.rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    });

    test('loads null when no state was written', async () => {
        assert.strictEqual(await new AutoClassifyStore(dir).load(), null);
    });

    test('loads null on corrupt JSON', async () => {
        fs.writeFileSync(path.join(dir, 'chatwizard-auto-classify.json'), 'not json', 'utf-8');
        assert.strictEqual(await new AutoClassifyStore(dir).load(), null);
    });

    test('loads null for an unknown schema version', async () => {
        fs.writeFileSync(
            path.join(dir, 'chatwizard-auto-classify.json'),
            JSON.stringify({ ...makeState(), version: 999 }),
            'utf-8',
        );
        assert.strictEqual(await new AutoClassifyStore(dir).load(), null);
    });

    test('round-trips the run state', async () => {
        const store = new AutoClassifyStore(dir);
        await store.save(makeState());

        const reloaded = await new AutoClassifyStore(dir).load();
        assert.ok(reloaded);
        assert.strictEqual(reloaded!.fingerprint, '3:abc');
        assert.strictEqual(reloaded!.classificationRevision, 2);
        assert.deepStrictEqual(reloaded!.amendments, emptyAmendments());
    });

    test('clear removes the file and is safe to call twice', async () => {
        const store = new AutoClassifyStore(dir);
        await store.save(makeState());
        await store.clear();
        assert.strictEqual(await store.load(), null);
        await store.clear();
    });
});
