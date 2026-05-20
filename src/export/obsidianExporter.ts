// src/export/obsidianExporter.ts
// Exports ChatWizard sessions to Obsidian-compatible Markdown vaults.
//
// Each session becomes a separate .md file in `targetDir` with:
//   - YAML frontmatter (title, source, date, tags, summary, chatwizard_id)
//   - Wikilinks for file paths found in importantFiles / entity file paths
//   - Standard user/assistant message formatting
//
// Feature 22: Obsidian/Notion Export

import * as fs from 'fs/promises';
import * as path from 'path';
import { Session } from '../types/index';
import { SessionMetadata } from '../types/index';
import { friendlySourceName } from '../ui/sourceUi';

export interface ObsidianExportOptions {
    /** Output directory (vault folder or sub-folder within it) */
    targetDir: string;
    /** Whether to overwrite existing files with the same name */
    overwrite?: boolean;
}

export interface ExportResult {
    /** Number of files written successfully */
    written: number;
    /** Number of files skipped (already exist and overwrite=false) */
    skipped: number;
    /** File paths of successfully written files */
    filePaths: string[];
    /** Errors encountered per session ID */
    errors: Array<{ sessionId: string; error: string }>;
}

// SEC-9: safe URL schemes only
const RE_SAFE_URL = /^https?:\/\/|^#|^\/[^/]|^\.\.?\//i;
const RE_MD_LINK = /\[([^\]]*)\]\(([^)]+)\)/g;

function sanitize(text: string): string {
    return text.replace(RE_MD_LINK, (_m, t, u) =>
        RE_SAFE_URL.test(u.trim()) ? `[${t}](${u})` : `[${t}]`
    );
}

/** Replace file path references with Obsidian wikilinks, e.g. `src/foo.ts` → `[[foo]]`. */
function wikilinkFilePaths(text: string, importantFiles: string[]): string {
    if (importantFiles.length === 0) { return text; }
    let result = text;
    for (const filePath of importantFiles) {
        const basename = path.basename(filePath, path.extname(filePath));
        const escaped = filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(new RegExp(escaped, 'g'), `[[${basename}]]`);
    }
    return result;
}

/** Sanitise a session title into a safe filename. */
function toFileName(title: string, sessionId: string): string {
    const safe = (title || 'Untitled')
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100);
    return `${safe} [${sessionId.slice(0, 8)}].md`;
}

/** Build YAML frontmatter block. */
function buildFrontmatter(session: Session, metadata?: SessionMetadata): string {
    const lines: string[] = ['---'];
    const title = (session.title || 'Untitled').replace(/"/g, '\\"');
    lines.push(`title: "${title}"`);
    lines.push(`source: "${friendlySourceName(session.source)}"`);
    lines.push(`date: "${session.updatedAt.slice(0, 10)}"`);
    lines.push(`chatwizard_id: "${session.id}"`);

    if (session.model) { lines.push(`model: "${session.model}"`); }

    const tags = metadata?.tags ?? [];
    if (tags.length > 0) {
        lines.push('tags:');
        for (const tag of tags) { lines.push(`  - ${tag}`); }
    }

    if (metadata?.summary) {
        const summary = metadata.summary.replace(/"/g, '\\"').slice(0, 200);
        lines.push(`summary: "${summary}"`);
    }

    lines.push('---');
    return lines.join('\n');
}

/** Serialize session messages to Markdown. */
function buildBody(session: Session, importantFiles: string[]): string {
    const lines: string[] = [];
    const visible = session.messages.filter(m => m.content.trim());

    for (const msg of visible) {
        const raw = sanitize(msg.content);
        const content = wikilinkFilePaths(raw, importantFiles);

        if (msg.role === 'user') {
            const heading = content.split('\n')[0].trim().slice(0, 120) || 'Prompt';
            lines.push(`\n---\n\n## ${heading}\n\n${content}\n`);
        } else {
            lines.push(`\n### Response\n\n${content}\n`);
        }
    }

    return lines.join('');
}

export class ObsidianExporter {
    /**
     * Exports an array of sessions to individual Markdown files in `targetDir`.
     * @param sessions  Sessions to export
     * @param options   Export options
     * @param getMetadata  Optional function to retrieve metadata per session ID
     */
    async export(
        sessions: Session[],
        options: ObsidianExportOptions,
        getMetadata?: (sessionId: string) => SessionMetadata | undefined | Promise<SessionMetadata | undefined>,
    ): Promise<ExportResult> {
        await fs.mkdir(options.targetDir, { recursive: true });

        const result: ExportResult = { written: 0, skipped: 0, filePaths: [], errors: [] };

        for (const session of sessions) {
            try {
                const fileName = toFileName(session.title, session.id);
                const outPath = path.join(options.targetDir, fileName);

                if (!options.overwrite) {
                    try {
                        await fs.access(outPath);
                        result.skipped++;
                        continue;
                    } catch { /* file does not exist — proceed */ }
                }

                const metadata = await getMetadata?.(session.id);
                const importantFiles = session.importantFiles ?? metadata?.entities?.filePaths ?? [];

                const frontmatter = buildFrontmatter(session, metadata);
                const body = buildBody(session, importantFiles);
                const content = `${frontmatter}\n${body}`;

                await fs.writeFile(outPath, content, 'utf8');
                result.written++;
                result.filePaths.push(outPath);
            } catch (err) {
                result.errors.push({ sessionId: session.id, error: String(err) });
            }
        }

        return result;
    }
}
