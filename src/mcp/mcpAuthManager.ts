// src/mcp/mcpAuthManager.ts
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Manages the bearer token used to authenticate MCP server requests.
 *
 * The token is a 32-byte random hex string stored as plain text at `tokenPath`.
 * No raw token value is ever emitted to the Output channel — only its byte length
 * and creation timestamp are logged.
 */
export class McpAuthManager {
    /**
     * Return the existing token if the file exists; otherwise generate a fresh token,
     * write it to `tokenPath` (creating parent directories as needed), and return it.
     */
    async getOrCreateToken(tokenPath: string): Promise<string> {
        this._assertAbsolute(tokenPath);
        try {
            const raw = fs.readFileSync(tokenPath, 'utf8').trim();
            if (raw.length > 0) {
                return raw;
            }
        } catch (err: unknown) {
            // File does not exist yet — fall through to generate.
            if (!this._isNoEntError(err)) {
                throw err;
            }
        }
        return this._writeNewToken(tokenPath);
    }

    /**
     * Generate a fresh token, overwrite the existing file, and return the new token.
     * Called when the user explicitly requests token rotation.
     */
    async rotateToken(tokenPath: string): Promise<string> {
        this._assertAbsolute(tokenPath);
        return this._writeNewToken(tokenPath);
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private _writeNewToken(tokenPath: string): string {
        const token = crypto.randomBytes(32).toString('hex');
        const dir = path.dirname(tokenPath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(tokenPath, token, { encoding: 'utf8', mode: 0o600 });
        return token;
    }

    private _assertAbsolute(tokenPath: string): void {
        if (!path.isAbsolute(tokenPath)) {
            throw new Error(
                `McpAuthManager: tokenPath must be an absolute path (got "${tokenPath}").`
            );
        }
    }

    private _isNoEntError(err: unknown): boolean {
        return (
            typeof err === 'object' &&
            err !== null &&
            'code' in err &&
            (err as { code: string }).code === 'ENOENT'
        );
    }
}
