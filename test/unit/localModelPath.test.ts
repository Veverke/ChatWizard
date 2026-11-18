// test/unit/localModelPath.test.ts
// Unit tests for the local model folder resolution used by semantic search.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    SEMANTIC_MODEL_ID,
    SEMANTIC_MODEL_ORG,
    findExistingModelFolder,
    modelFolderCandidates,
    resolveLocalModel,
} from '../../src/search/localModelPath';

const ALL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];

/** Creates a model folder at `dir` containing `files` (dotted paths). */
function writeModel(dir: string, files: readonly string[] = ALL_FILES): string {
    for (const relative of files) {
        const target = path.join(dir, ...relative.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, relative.endsWith('.json') ? '{}' : 'onnx-bytes');
    }
    return dir;
}

suite('localModelPath.resolveLocalModel', () => {
    let root: string;

    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-local-model-'));
    });

    teardown(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('empty path is reported as missing everything', () => {
        const resolved = resolveLocalModel('');
        assert.strictEqual(resolved.modelFolder, '');
        assert.ok(resolved.missing.includes('config.json'));
    });

    test('reads the model folder when pointed at it directly', () => {
        const folder = writeModel(path.join(root, SEMANTIC_MODEL_ID));
        const resolved = resolveLocalModel(folder);
        assert.strictEqual(resolved.modelFolder, folder);
        assert.strictEqual(resolved.root, root);
        assert.strictEqual(resolved.modelId, SEMANTIC_MODEL_ID);
        assert.strictEqual(resolved.onnxFile, 'onnx/model_quantized.onnx');
        assert.strictEqual(resolved.quantized, true);
        assert.deepStrictEqual(resolved.missing, []);
    });

    test('finds <root>/Xenova/all-MiniLM-L6-v2 when pointed at the models root', () => {
        const folder = writeModel(path.join(root, 'Xenova', SEMANTIC_MODEL_ID));
        const resolved = resolveLocalModel(root);
        assert.strictEqual(resolved.modelFolder, folder);
        assert.deepStrictEqual(resolved.missing, []);
        // root + modelId must resolve back to the model folder (org kept in the id).
        assert.strictEqual(path.join(resolved.root, ...resolved.modelId.split('/')), folder);
        assert.strictEqual(resolved.modelId, `${SEMANTIC_MODEL_ORG}/${SEMANTIC_MODEL_ID}`);
    });

    test('finds <root>/all-MiniLM-L6-v2 when pointed at the Xenova folder', () => {
        const org = path.join(root, SEMANTIC_MODEL_ORG);
        const folder = writeModel(path.join(org, SEMANTIC_MODEL_ID));
        const resolved = resolveLocalModel(org);
        assert.strictEqual(resolved.modelFolder, folder);
        assert.strictEqual(path.join(resolved.root, ...resolved.modelId.split('/')), folder);
    });

    test('reports a missing tokenizer file', () => {
        const folder = writeModel(path.join(root, SEMANTIC_MODEL_ID), ALL_FILES.filter(f => f !== 'tokenizer.json'));
        const resolved = resolveLocalModel(folder);
        assert.deepStrictEqual(resolved.missing, ['tokenizer.json']);
    });

    test('reports a missing ONNX file', () => {
        const folder = writeModel(path.join(root, SEMANTIC_MODEL_ID), ['config.json', 'tokenizer.json']);
        const resolved = resolveLocalModel(folder);
        assert.deepStrictEqual(resolved.missing, ['onnx/model_quantized.onnx']);
        assert.strictEqual(resolved.onnxFile, '');
    });

    test('uses the full ONNX model when only model.onnx exists', () => {
        const folder = writeModel(path.join(root, SEMANTIC_MODEL_ID), [
            'config.json', 'tokenizer.json', 'onnx/model.onnx',
        ]);
        const resolved = resolveLocalModel(folder);
        assert.strictEqual(resolved.onnxFile, 'onnx/model.onnx');
        assert.strictEqual(resolved.quantized, false);
        assert.deepStrictEqual(resolved.missing, []);
    });

    test('an empty folder has no usable model', () => {
        const resolved = resolveLocalModel(root);
        assert.strictEqual(resolved.modelFolder, '');
        assert.ok(resolved.missing.length > 0);
    });
});

suite('localModelPath.findExistingModelFolder', () => {
    let root: string;

    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-find-model-'));
    });

    teardown(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('finds a model nested in a legacy cache layout', () => {
        const nested = path.join(root, 'huggingface.co', 'Xenova', SEMANTIC_MODEL_ID, 'resolve', 'main');
        writeModel(nested);
        assert.strictEqual(findExistingModelFolder(root), nested);
    });

    test('returns undefined when no complete model exists', () => {
        const partial = path.join(root, 'Xenova', SEMANTIC_MODEL_ID);
        writeModel(partial, ['config.json', 'tokenizer.json']); // no ONNX weights
        assert.strictEqual(findExistingModelFolder(root), undefined);
    });

    test('returns undefined for a missing root', () => {
        assert.strictEqual(findExistingModelFolder(path.join(root, 'nope')), undefined);
    });
});

suite('localModelPath.modelFolderCandidates', () => {
    test('lists the three supported layouts, most specific first', () => {
        const candidates = modelFolderCandidates('/models');
        assert.strictEqual(candidates.length, 3);
        assert.ok(candidates[0].endsWith('models'));
        assert.ok(candidates[1].endsWith(path.join('Xenova', SEMANTIC_MODEL_ID)));
        assert.ok(candidates[2].endsWith(SEMANTIC_MODEL_ID));
    });
});
