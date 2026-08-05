// src/analytics/entityExtractor.ts
// Extracts structured entities from session content (Feature 19):
//   - File paths
//   - Function and class names
//   - Error messages and HTTP status codes
//   - Decision phrases
//   - Semantic entities (frameworks, APIs, concepts, tools, languages) via LLM
//
// extractEntities() is a pure function — no I/O, fully unit-testable.
// extractEntitiesSmart() tries the LLM first, then falls back to the regex path.
// runEntityExtractionJob() (further down) performs background I/O via SidecarMetadataStore.

import { Session, ExtractedEntities } from '../types/index';
import { SidecarMetadataStore } from '../index/sidecarMetadataStore';
import { extractEntitiesWithLlm } from './entityLlmExtractor';

/** Current version of the extractor — bump when extraction logic changes to invalidate caches. */
export const ENTITIES_VERSION = 2;

// ─── Regex patterns ───────────────────────────────────────────────────────────

const FILE_PATH_RE = /\b([\w.\-/\\]+\.(?:ts|js|mjs|cjs|tsx|jsx|py|go|rs|java|cs|cpp|c|h|rb|php|swift|kt|json|yaml|yml|toml|md|sh|bash|zsh|html|css|scss|sql|graphql|proto|xml|env|prisma))\b/g;

const FUNCTION_CLASS_RE = /\b(?:function|class|const|let|var|def|fn|func|method|async function|export function|export default function|export class|abstract class|interface)\s+([A-Za-z_]\w+)/g;

const BACKTICK_FUNC_RE = /`([A-Za-z_]\w+)\(\)`/g;

const ERROR_RE = /\b((?:Error|Exception|TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|NetworkError|TimeoutError|AbortError|NotFoundError|PermissionError|IOError|ValueError|KeyError|IndexError|AttributeError|RuntimeError|OverflowError|MemoryError|RecursionError)\b[^.;\n]*|[A-Za-z]\w+(?:Error|Exception)\b[^.;\n]*|SQLITE_\w+|ENOENT|EACCES|EPERM|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|EADDRINUSE|ENOMEM|E[A-Z_]{2,}|4\d\d\s+\w[\w\s]{0,30}|5\d\d\s+\w[\w\s]{0,30})/g;

const DECISION_RE = /\b(?:I\s+(?:decided|chose|will use|am going to|have decided|went with)|we\s+(?:chose|decided|will use|went with|are going to)|the\s+(?:approach|decision|plan|strategy|solution)\s+is|decided\s+to\s+use|going\s+with|sticking\s+with|opted\s+for)\s+.{0,80}/gi;

// ─── Extractor ────────────────────────────────────────────────────────────────

/**
 * Extracts structured entities from a session.
 * Pure function — all input via parameters, no side effects.
 */
export function extractEntities(session: Session): ExtractedEntities {
    const allContent = session.messages.map(m => m.content).join('\n');

    const filePaths = extractUnique(allContent, FILE_PATH_RE, 50);
    const functionNames = extractFunctionNames(allContent);
    const errors = extractUnique(allContent, ERROR_RE, 30);
    const decisions = extractDecisions(allContent);

    return { filePaths, functionNames, errors, decisions };
}

function extractUnique(text: string, re: RegExp, maxItems: number): string[] {
    const seen = new Set<string>();
    const results: string[] = [];
    const clone = new RegExp(re.source, re.flags);
    let match: RegExpExecArray | null;

    while ((match = clone.exec(text)) !== null && results.length < maxItems) {
        const val = (match[1] ?? match[0]).trim();
        const key = val.toLowerCase();
        if (val && !seen.has(key)) {
            seen.add(key);
            results.push(val);
        }
    }

    return results;
}

function extractFunctionNames(text: string): string[] {
    const seen = new Set<string>();
    const results: string[] = [];

    // keyword + name pattern
    const clone1 = new RegExp(FUNCTION_CLASS_RE.source, FUNCTION_CLASS_RE.flags);
    let m: RegExpExecArray | null;
    while ((m = clone1.exec(text)) !== null && results.length < 40) {
        const name = m[1];
        if (name && !seen.has(name)) {
            seen.add(name);
            results.push(name);
        }
    }

    // backtick `name()` pattern
    const clone2 = new RegExp(BACKTICK_FUNC_RE.source, BACKTICK_FUNC_RE.flags);
    while ((m = clone2.exec(text)) !== null && results.length < 40) {
        const name = m[1];
        if (name && !seen.has(name)) {
            seen.add(name);
            results.push(name);
        }
    }

    return results;
}

function extractDecisions(text: string): string[] {
    const results: string[] = [];
    const clone = new RegExp(DECISION_RE.source, DECISION_RE.flags);
    let m: RegExpExecArray | null;

    while ((m = clone.exec(text)) !== null && results.length < 20) {
        const val = m[0].trim().replace(/\s+/g, ' ');
        if (val.length > 5) {
            results.push(val);
        }
    }

    return results;
}

// ─── Smart extraction (LLM-first with regex fallback) ────────────────────────

/**
 * Extracts entities from a session, trying the LLM pass first and falling
 * back to the pure regex extractor when the LM API is unavailable.
 *
 * The regex result is always merged in (it is cheap and precise for
 * file paths / errors), while the LLM adds semantic entities.
 */
export async function extractEntitiesSmart(session: Session): Promise<ExtractedEntities> {
    // 1. Regex pass — precise for structured entities
    const regexResult = extractEntities(session);

    // 2. LLM pass — semantic entities; graceful fallback on failure
    let semantic: string[] | undefined;
    try {
        const llmResult = await extractEntitiesWithLlm(session);
        semantic = llmResult?.semantic;
    } catch {
        // LM API unavailable — keep regex-only result
    }

    if (semantic && semantic.length > 0) {
        // Deduplicate against regex-extracted values
        const seen = new Set<string>(
            [...regexResult.filePaths, ...regexResult.functionNames, ...regexResult.errors, ...regexResult.decisions]
                .map(v => v.toLowerCase()),
        );
        const filtered = semantic.filter(item => !seen.has(item.toLowerCase()));
        return { ...regexResult, semantic: filtered };
    }

    return regexResult;
}

// ─── Background job ───────────────────────────────────────────────────────────

/**
 * Runs entity extraction for all sessions that lack up-to-date entities.
 * Processes in batches to stay non-blocking.
 */
export async function runEntityExtractionJob(
    getAllSessionIds: () => string[],
    getSession: (id: string) => Session | undefined,
    store: SidecarMetadataStore,
    channel: { appendLine(msg: string): void },
): Promise<void> {
    // Yield to allow summary job (higher priority) to start first
    await delay(5000);

    const ids = getAllSessionIds();
    let processed = 0;
    let skipped = 0;
    const BATCH_SIZE = 50;

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE);

        for (const id of batch) {
            const existing = await store.get(id);
            if (existing?.entitiesVersion === ENTITIES_VERSION) {
                skipped++;
                continue;
            }

            const session = getSession(id);
            if (!session) { continue; }

            try {
                const entities = await extractEntitiesSmart(session);
                await store.patch(id, { entities, entitiesVersion: ENTITIES_VERSION });
                processed++;
            } catch (err) {
                channel.appendLine(`[entities] Failed for ${id}: ${err}`);
            }
        }

        await delay(10);
    }

    channel.appendLine(`[entities] Background job complete — extracted: ${processed}, already cached: ${skipped}`);
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
