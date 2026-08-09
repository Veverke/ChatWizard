// src/search/semanticIndex.ts

import * as fs from 'fs';
import * as path from 'path';
import { ISemanticIndex, SEMANTIC_DIMS, SemanticScope } from './semanticContracts';
import { SemanticMessageResult } from './types';

/** Magic bytes "CWSE" */
const MAGIC = Buffer.from([0x43, 0x57, 0x53, 0x45]);
// v3: session titles are now indexed as synthetic user entries (messageIndex = -1).
// Bumping the version discards any v2 index so all sessions are re-indexed with titles.
const FILE_VERSION = 3;

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

    /** O(1) session presence check — updated in sync with _store */
    private readonly _indexedSessions = new Set<string>();

    // ── size ───────────────────────────────────────────────────────────────

    get size(): number {
        return this._store.size;
    }

    // ── CRUD ───────────────────────────────────────────────────────────────

    add(sessionId: string, role: 'user' | 'assistant', messageIndex: number, paragraphIndex: number, embedding: Float32Array): void {
        this._store.set(makeKey(sessionId, role, messageIndex, paragraphIndex), embedding);
        this._indexedSessions.add(sessionId);
    }

    remove(sessionId: string): void {
        if (!this._indexedSessions.has(sessionId)) { return; }
        const prefix = `${sessionId}::`;
        for (const key of this._store.keys()) {
            if (key.startsWith(prefix)) {
                this._store.delete(key);
            }
        }
        this._indexedSessions.delete(sessionId);
    }

    has(sessionId: string): boolean {
        return this._indexedSessions.has(sessionId);
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

            // Bulk-write the 384 float32 values via a TypedArray view into the
            // same underlying Buffer — avoids 384 individual writeFloatLE calls.
            new Float32Array(buf.buffer, buf.byteOffset + offset, SEMANTIC_DIMS).set(embedding);
            offset += SEMANTIC_DIMS * 4;
        }

        // Atomic write: write to a temp file first, then rename.
        // This prevents partial/corrupt files when VS Code shuts down mid-write.
        const tmpPath = filePath + '.tmp';
        // Ensure parent directory exists
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        await fs.promises.writeFile(tmpPath, buf);
        await fs.promises.rename(tmpPath, filePath);
    }

    /** Synchronous variant of save() — used in dispose() where await is unavailable.
     *
     * NOTE: This writes directly to the target file (no .tmp + rename) because
     * dispose() may race with a pending async save() that is already using the
     * same .tmp path.  At shutdown there are no concurrent readers, so a direct
     * write is safe and avoids the race. */
    saveSync(filePath: string): void {
        const entries = [...this._store.entries()];
        const N = entries.length;

        let totalSize = 16;
        const keyBufs: Buffer[] = [];
        for (const [key] of entries) {
            const keyBuf = Buffer.from(key, 'utf8');
            keyBufs.push(keyBuf);
            totalSize += 4 + keyBuf.byteLength + SEMANTIC_DIMS * 4;
        }

        const buf = Buffer.allocUnsafe(totalSize);
        let offset = 0;

        MAGIC.copy(buf, offset); offset += 4;
        buf.writeUInt32LE(FILE_VERSION, offset); offset += 4;
        buf.writeUInt32LE(SEMANTIC_DIMS, offset); offset += 4;
        buf.writeUInt32LE(N, offset); offset += 4;

        for (let i = 0; i < N; i++) {
            const keyBuf = keyBufs[i];
            const embedding = entries[i][1];

            buf.writeUInt32LE(keyBuf.byteLength, offset); offset += 4;
            keyBuf.copy(buf, offset); offset += keyBuf.byteLength;

            // Bulk-write the 384 float32 values via a TypedArray view into the
            // same underlying Buffer — avoids 384 individual writeFloatLE calls.
            new Float32Array(buf.buffer, buf.byteOffset + offset, SEMANTIC_DIMS).set(embedding);
            offset += SEMANTIC_DIMS * 4;
        }

        // Ensure parent directory exists
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Use a unique temp path (.tmp.sync) that CANNOT collide with the async
        // save() path (.tmp).  This prevents a race where an in-flight async
        // save() captured a stale snapshot of _store before dispose() ran, then
        // its rename(.tmp → filePath) overwrites the fresh data we write here.
        const tmpPath = filePath + '.tmp.sync';
        fs.writeFileSync(tmpPath, buf);
        fs.renameSync(tmpPath, filePath);

        // Remove the stale .tmp left by a racing async save() so its pending
        // rename target no longer exists (rename will fail harmlessly).
        try { fs.unlinkSync(filePath + '.tmp'); } catch { /* never existed */ }
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
            this._indexedSessions.clear();

            const embeddingBytes = SEMANTIC_DIMS * 4;

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

                if (offset + embeddingBytes > raw.byteLength) {
                    throw new Error(`Unexpected end of file reading entry ${i} embedding`);
                }
                // Bulk-read the 384 float32 values via a TypedArray view into the
                // underlying ArrayBuffer — avoids 384 individual readFloatLE calls
                // per entry, which was causing a 10-second timeout on large indexes.
                const embedding = new Float32Array(
                    raw.buffer,
                    raw.byteOffset + offset,
                    SEMANTIC_DIMS,
                );
                offset += embeddingBytes;

                this._store.set(key, new Float32Array(embedding));
                // Rebuild _indexedSessions from loaded keys
                const parsed = parseKey(key);
                if (parsed) { this._indexedSessions.add(parsed.sessionId); }
            }
        } catch (err) {
            console.warn(
                `[ChatWizard] SemanticIndex: failed to load "${filePath}" — ` +
                `${(err as Error).message}. Starting with empty index.`
            );
            this._store.clear();
            this._indexedSessions.clear();
            // Delete the corrupt file so the next startup regenerates it instead of failing again.
            try {
                await fs.promises.unlink(filePath);
            } catch {
                // Ignore — the file may not exist or may be locked; a fresh start will still work.
            }
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
