// src/search/semanticIndex.ts

import * as fs from 'fs';
import { ISemanticIndex, SEMANTIC_DIMS, SemanticScope } from './semanticContracts';
import { SemanticMessageResult } from './types';

/** Magic bytes "CWSE" */
const MAGIC = Buffer.from([0x43, 0x57, 0x53, 0x45]);
const FILE_VERSION = 2;

/**
 * Composite key format: "sessionId::role::messageIndex::paragraphIndex"
 * Examples:
 *   user message at index 2:          "abc123::user::2::0"
 *   AI response at index 1, para 3:   "abc123::assistant::1::3"
 */
function makeKey(sessionId: string, role: 'user' | 'assistant', messageIndex: number, paragraphIndex: number): string {
    return `${sessionId}::${role}::${messageIndex}::${paragraphIndex}`;
}

function parseKey(key: string): { sessionId: string; role: 'user' | 'assistant'; messageIndex: number; paragraphIndex: number } | null {
    const parts = key.split('::');
    if (parts.length < 4) { return null; }
    // sessionId itself may contain '::' — everything except the last 3 parts is the sessionId
    const paragraphIndex = parseInt(parts[parts.length - 1], 10);
    const messageIndex   = parseInt(parts[parts.length - 2], 10);
    const role           = parts[parts.length - 3] as 'user' | 'assistant';
    const sessionId      = parts.slice(0, parts.length - 3).join('::');
    if (isNaN(messageIndex) || isNaN(paragraphIndex)) { return null; }
    if (role !== 'user' && role !== 'assistant') { return null; }
    return { sessionId, role, messageIndex, paragraphIndex };
}

/**
 * In-memory vector store backed by a binary file so embeddings survive
 * VS Code restarts. Keys are composite strings encoding session, role, and
 * paragraph position. Vectors are pre-normalized; cosine similarity is a
 * plain dot product.
 *
 * Binary format v2:
 *   [4] magic "CWSE"
 *   [4] version: 2 (uint32 LE)
 *   [4] dims: 384 (uint32 LE)
 *   [4] entry count N (uint32 LE)
 *   [N entries]
 *     [4] composite key byte length (uint32 LE)
 *     [var] composite key UTF-8 bytes
 *     [dims×4] float32 embedding (little-endian)
 */
export class SemanticIndex implements ISemanticIndex {
    private readonly _store = new Map<string, Float32Array>();

    // ── size ───────────────────────────────────────────────────────────────

    get size(): number {
        return this._store.size;
    }

    // ── CRUD ───────────────────────────────────────────────────────────────

    add(sessionId: string, role: 'user' | 'assistant', messageIndex: number, paragraphIndex: number, embedding: Float32Array): void {
        this._store.set(makeKey(sessionId, role, messageIndex, paragraphIndex), embedding);
    }

    remove(sessionId: string): void {
        const prefix = `${sessionId}::`;
        for (const key of this._store.keys()) {
            if (key.startsWith(prefix)) {
                this._store.delete(key);
            }
        }
    }

    has(sessionId: string): boolean {
        const prefix = `${sessionId}::`;
        for (const key of this._store.keys()) {
            if (key.startsWith(prefix)) { return true; }
        }
        return false;
    }

    // ── Search ─────────────────────────────────────────────────────────────

    search(queryEmbedding: Float32Array, topK: number, minScore = 0, scope: SemanticScope = 'both'): SemanticMessageResult[] {
        const results: SemanticMessageResult[] = [];

        for (const [key, embedding] of this._store) {
            // Scope filter: skip keys whose role doesn't match
            if (scope !== 'both') {
                // Fast check: role is the second-to-last segment before the two numeric parts
                // Use the full parse only when we can't shortcut
                const roleMarker = scope === 'user' ? '::user::' : '::assistant::';
                const otherMarker = scope === 'user' ? '::assistant::' : '::user::';
                if (key.includes(otherMarker) && !key.includes(roleMarker)) { continue; }
                // Edge: key could contain both markers if sessionId is pathological — use full parse
                const parsed = parseKey(key);
                if (!parsed || parsed.role !== scope) { continue; }
            }

            const score = dot(queryEmbedding, embedding);
            if (score >= minScore) {
                const parsed = parseKey(key);
                if (!parsed) { continue; }
                results.push({ ...parsed, score });
            }
        }

        results.sort((a, b) => b.score - a.score);
        return results.slice(0, topK);
    }

    // ── Persistence ────────────────────────────────────────────────────────

    async save(filePath: string): Promise<void> {
        const entries = [...this._store.entries()];
        const N = entries.length;

        let totalSize = 16; // magic(4) + version(4) + dims(4) + count(4)
        const keyBufs: Buffer[] = [];
        for (const [key] of entries) {
            const keyBuf = Buffer.from(key, 'utf8');
            keyBufs.push(keyBuf);
            totalSize += 4 + keyBuf.byteLength + SEMANTIC_DIMS * 4;
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
            const keyBuf = keyBufs[i];
            const embedding = entries[i][1];

            buf.writeUInt32LE(keyBuf.byteLength, offset); offset += 4;
            keyBuf.copy(buf, offset); offset += keyBuf.byteLength;

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
                console.warn(
                    `[ChatWizard] SemanticIndex: unrecognised file version ${version} in "${filePath}". Starting with empty index.`
                );
                return;
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
                    throw new Error(`Unexpected end of file reading entry ${i} key length`);
                }
                const keyLen = raw.readUInt32LE(offset); offset += 4;

                if (offset + keyLen > raw.byteLength) {
                    throw new Error(`Unexpected end of file reading entry ${i} key bytes`);
                }
                const key = raw.toString('utf8', offset, offset + keyLen);
                offset += keyLen;

                const embeddingBytes = SEMANTIC_DIMS * 4;
                if (offset + embeddingBytes > raw.byteLength) {
                    throw new Error(`Unexpected end of file reading entry ${i} embedding`);
                }
                const embedding = new Float32Array(SEMANTIC_DIMS);
                for (let d = 0; d < SEMANTIC_DIMS; d++) {
                    embedding[d] = raw.readFloatLE(offset); offset += 4;
                }

                this._store.set(key, embedding);
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
