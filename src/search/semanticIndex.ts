// src/search/semanticIndex.ts

import * as fs from 'fs';
import { ISemanticIndex, SEMANTIC_DIMS } from './semanticContracts';
import { SemanticSearchResult } from './types';

/** Magic bytes "CWSE" */
const MAGIC = Buffer.from([0x43, 0x57, 0x53, 0x45]);
const FILE_VERSION = 1;

/**
 * In-memory vector store backed by a binary file so embeddings survive
 * VS Code restarts. Vectors are assumed to be pre-normalized (unit length);
 * cosine similarity is computed as a plain dot product.
 */
export class SemanticIndex implements ISemanticIndex {
    private readonly _store = new Map<string, Float32Array>();

    // ── size ───────────────────────────────────────────────────────────────

    get size(): number {
        return this._store.size;
    }

    // ── CRUD ───────────────────────────────────────────────────────────────

    add(sessionId: string, embedding: Float32Array): void {
        this._store.set(sessionId, embedding);
    }

    remove(sessionId: string): void {
        this._store.delete(sessionId);
    }

    has(sessionId: string): boolean {
        return this._store.has(sessionId);
    }

    // ── Search ─────────────────────────────────────────────────────────────

    search(queryEmbedding: Float32Array, topK: number, minScore = 0): SemanticSearchResult[] {
        const results: SemanticSearchResult[] = [];

        for (const [sessionId, embedding] of this._store) {
            const score = dot(queryEmbedding, embedding);
            if (score >= minScore) {
                results.push({ sessionId, score });
            }
        }

        results.sort((a, b) => b.score - a.score);
        return results.slice(0, topK);
    }

    // ── Persistence ────────────────────────────────────────────────────────

    async save(filePath: string): Promise<void> {
        const entries = [...this._store.entries()];
        const N = entries.length;

        // Calculate total byte size up front so we can allocate one buffer.
        let totalSize = 16; // magic(4) + version(4) + dims(4) + count(4)
        const idBufs: Buffer[] = [];
        for (const [id] of entries) {
            const idBuf = Buffer.from(id, 'utf8');
            idBufs.push(idBuf);
            totalSize += 4 + idBuf.byteLength + SEMANTIC_DIMS * 4;
        }

        const buf = Buffer.allocUnsafe(totalSize);
        let offset = 0;

        // Header
        MAGIC.copy(buf, offset); offset += 4;
        buf.writeUInt32LE(FILE_VERSION, offset); offset += 4;
        buf.writeUInt32LE(SEMANTIC_DIMS, offset); offset += 4;
        buf.writeUInt32LE(N, offset); offset += 4;

        // Entries
        for (let i = 0; i < N; i++) {
            const idBuf = idBufs[i];
            const embedding = entries[i][1];

            buf.writeUInt32LE(idBuf.byteLength, offset); offset += 4;
            idBuf.copy(buf, offset); offset += idBuf.byteLength;

            for (let d = 0; d < SEMANTIC_DIMS; d++) {
                buf.writeFloatLE(embedding[d], offset); offset += 4;
            }
        }

        await fs.promises.writeFile(filePath, buf);
    }

    async load(filePath: string): Promise<void> {
        let raw: Buffer;
        try {
            raw = await fs.promises.readFile(filePath);
        } catch {
            // Missing file — start empty
            return;
        }

        try {
            if (raw.byteLength < 16) {
                throw new Error('File too short to contain header');
            }

            // Validate magic
            if (
                raw[0] !== MAGIC[0] ||
                raw[1] !== MAGIC[1] ||
                raw[2] !== MAGIC[2] ||
                raw[3] !== MAGIC[3]
            ) {
                throw new Error('Invalid magic bytes');
            }

            let offset = 4;
            const version = raw.readUInt32LE(offset); offset += 4;
            if (version !== FILE_VERSION) {
                throw new Error(`Unsupported file version: ${version}`);
            }

            const dims = raw.readUInt32LE(offset); offset += 4;
            if (dims !== SEMANTIC_DIMS) {
                console.warn(
                    `[ChatWizard] SemanticIndex: dims mismatch in "${filePath}" ` +
                    `(file=${dims}, expected=${SEMANTIC_DIMS}). Starting with empty index.`
                );
                return;
            }

            const N = raw.readUInt32LE(offset); offset += 4;

            this._store.clear();

            for (let i = 0; i < N; i++) {
                if (offset + 4 > raw.byteLength) {
                    throw new Error(`Unexpected end of file reading entry ${i} id length`);
                }
                const idLen = raw.readUInt32LE(offset); offset += 4;

                if (offset + idLen > raw.byteLength) {
                    throw new Error(`Unexpected end of file reading entry ${i} id bytes`);
                }
                const sessionId = raw.toString('utf8', offset, offset + idLen);
                offset += idLen;

                const embeddingBytes = SEMANTIC_DIMS * 4;
                if (offset + embeddingBytes > raw.byteLength) {
                    throw new Error(`Unexpected end of file reading entry ${i} embedding`);
                }
                const embedding = new Float32Array(SEMANTIC_DIMS);
                for (let d = 0; d < SEMANTIC_DIMS; d++) {
                    embedding[d] = raw.readFloatLE(offset); offset += 4;
                }

                this._store.set(sessionId, embedding);
            }
        } catch (err) {
            console.warn(
                `[ChatWizard] SemanticIndex: failed to load "${filePath}" — ` +
                `${(err as Error).message}. Starting with empty index.`
            );
            this._store.clear();
        }
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Dot product of two equal-length vectors (cosine sim for unit vectors). */
function dot(a: Float32Array, b: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        sum += a[i] * b[i];
    }
    return sum;
}
