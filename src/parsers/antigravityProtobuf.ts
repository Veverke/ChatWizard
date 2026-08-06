// src/parsers/antigravityProtobuf.ts
// Feature 40 — Antigravity .pb (Protobuf) support

import * as fs from 'fs';
import * as path from 'path';
import type { Session, ParseResult } from '../types/index';

const MIN_STRING_LENGTH = 20;

export interface ProtobufScanResult {
    /** All length-delimited text strings found in the buffer */
    strings: string[];
    lowFidelity: true;
}

/**
 * Read a protobuf varint (LEB128-encoded unsigned integer) from a buffer
 * starting at the given offset. Returns the decoded value and the number
 * of bytes consumed.
 */
function readVarint(buffer: Buffer, offset: number): { value: number; bytesRead: number } | null {
    let value = 0;
    let shift = 0;
    let bytesRead = 0;

    while (offset + bytesRead < buffer.length) {
        const byte = buffer[offset + bytesRead];
        bytesRead++;
        value |= (byte & 0x7f) << shift;
        shift += 7;
        if ((byte & 0x80) === 0) {
            return { value, bytesRead };
        }
        // Safety: varints shouldn't be > 10 bytes for 64-bit values
        if (bytesRead > 10) { return null; }
    }
    return null;
}

/**
 * Scan a binary protobuf buffer for wire-type 2 (length-delimited) fields.
 * Extracts all byte sequences that are valid UTF-8 strings of at least
 * MIN_STRING_LENGTH characters.
 *
 * This is a best-effort scanner — it does not require a .proto schema.
 * It iterates through the buffer looking for valid varint tags followed by
 * length-prefixed byte sequences that decode as UTF-8 text.
 *
 * Does not throw on malformed data — returns an empty strings array instead.
 */
export function scanProtobufStrings(buffer: Buffer): ProtobufScanResult {
    const strings: string[] = [];

    if (buffer.length === 0) {
        return { strings, lowFidelity: true };
    }

    try {
        let offset = 0;

        while (offset < buffer.length) {
            // Read the field tag varint
            const tagResult = readVarint(buffer, offset);
            if (!tagResult) { break; }
            offset += tagResult.bytesRead;

            const wireType = tagResult.value & 0x07;

            if (wireType === 0) {
                // Wire type 0: varint — skip the value
                const valResult = readVarint(buffer, offset);
                if (!valResult) { break; }
                offset += valResult.bytesRead;

            } else if (wireType === 1) {
                // Wire type 1: 64-bit fixed — skip 8 bytes
                offset += 8;

            } else if (wireType === 2) {
                // Wire type 2: length-delimited
                const lenResult = readVarint(buffer, offset);
                if (!lenResult) { break; }
                offset += lenResult.bytesRead;

                const dataLen = lenResult.value;
                if (dataLen < 0 || offset + dataLen > buffer.length) {
                    // Skip invalid length
                    break;
                }

                const data = buffer.slice(offset, offset + dataLen);
                offset += dataLen;

                // Try to decode as UTF-8
                try {
                    const text = data.toString('utf8');
                    // Validate: must be valid UTF-8 and at least MIN_STRING_LENGTH chars
                    // Check by re-encoding — if it round-trips, it's valid UTF-8
                    if (
                        text.length >= MIN_STRING_LENGTH &&
                        Buffer.from(text, 'utf8').equals(data) &&
                        /\w/.test(text) // must contain at least one word character
                    ) {
                        strings.push(text);
                    }
                } catch {
                    // Not valid UTF-8 — skip
                }

            } else if (wireType === 5) {
                // Wire type 5: 32-bit fixed — skip 4 bytes
                offset += 4;

            } else {
                // Unknown wire type — can't safely continue parsing
                break;
            }
        }
    } catch {
        // Any unexpected error — return what we have so far
    }

    return { strings, lowFidelity: true };
}

/**
 * Parse an Antigravity .pb file into a Session with `lowFidelity: true` metadata.
 *
 * Since we don't have the protobuf schema, we treat every extracted string as
 * an assistant message (role cannot be determined from wire format alone).
 * The title is derived from the first extracted string, truncated to 80 chars.
 */
export function parseAntigravityPbFile(pbPath: string): ParseResult {
    const fileId = path.basename(pbPath, path.extname(pbPath));

    const emptySession: Session = {
        id: fileId,
        title: fileId,
        source: 'antigravity',
        subSource: 'pb',
        workspaceId: fileId,
        messages: [],
        filePath: pbPath,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
    };

    let buffer: Buffer;
    try {
        buffer = fs.readFileSync(pbPath);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
            session: emptySession,
            errors: [`Failed to read file: ${msg}`],
        };
    }

    const { strings } = scanProtobufStrings(buffer);

    if (strings.length === 0) {
        return {
            session: {
                ...emptySession,
                parseErrors: ['No readable strings found in .pb file'],
            },
            errors: ['No readable strings found in .pb file'],
        };
    }

    const title = strings[0].slice(0, 80).replace(/\n/g, ' ');

    let fileSizeBytes: number | undefined;
    let mtime: string | undefined;
    try {
        const stat = fs.statSync(pbPath);
        fileSizeBytes = stat.size;
        mtime = stat.mtime.toISOString();
    } catch { /* ignore */ }

    const messages = strings.map((text, i) => ({
        id: `${fileId}-${i}`,
        role: 'assistant' as const,  // role unknown from wire format
        content: text,
        codeBlocks: [],
    }));

    return {
        session: {
            id: fileId,
            title,
            source: 'antigravity',
            subSource: 'pb',
            workspaceId: fileId,
            messages,
            filePath: pbPath,
            fileSizeBytes,
            createdAt: mtime ?? new Date(0).toISOString(),
            updatedAt: mtime ?? new Date(0).toISOString(),
        },
        errors: [],
    };
}