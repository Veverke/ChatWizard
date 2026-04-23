// src/analytics/modelUsageEngine.ts

import { SessionSummary, SessionSource, ModelEntry, ModelUsageData, WorkspaceUsage, AssistantUsage, SessionUsage, SourceBreakdown } from '../types/index';
import { friendlyModelName } from './modelNames';

function toDateStr(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Normalize a workspace path/id to a stable deduplication key. */
function normalizeWsKey(raw: string): string {
    return raw.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Source-aware model name: falls back to a branded label when model is unknown. */
const SOURCE_AUTO_MODEL: Partial<Record<SessionSource, string>> = {
    cursor:      'Cursor Auto',
    cline:       'Cline Auto',
    roocode:     'Roo Code Auto',
    windsurf:    'Windsurf Auto',
    aider:       'Aider Auto',
    antigravity: 'Gemini Auto',
};

function resolveModel(raw: string | undefined, source: SessionSource): string {
    const name = friendlyModelName(raw);
    if (name !== 'Unknown') { return name; }
    return SOURCE_AUTO_MODEL[source] ?? 'Unknown';
}

export function computeModelUsage(
    summaries: SessionSummary[],
    from: Date,
    to: Date
): ModelUsageData {
    const fromStr = toDateStr(from);
    const toStr = toDateStr(to);

    // Key = model name — sessions from different assistants using the same model are merged
    const modelMap = new Map<string, {
        sources: Set<SessionSource>;
        model: string;
        sessionCount: number;
        userRequests: number;
        // normalized key → { displayPath, total, assistantMap: source→count }
        wsMap: Map<string, { displayPath: string; total: number; assistantMap: Map<string, number> }>;
        sessionMap: Map<string, { title: string; userRequests: number }>;
        // per-source tracking
        sourceMap: Map<SessionSource, {
            sessionCount: number;
            userRequests: number;
            sessionMap: Map<string, { title: string; userRequests: number }>;
        }>;
    }>();
    let totalSessions = 0;
    let totalUserRequests = 0;

    for (const s of summaries) {
        const dateStr = s.updatedAt.slice(0, 10);
        if (dateStr < fromStr || dateStr > toStr) { continue; }

        const model = resolveModel(s.model, s.source);
        let entry = modelMap.get(model);
        if (!entry) {
            entry = { sources: new Set(), model, sessionCount: 0, userRequests: 0, wsMap: new Map(), sessionMap: new Map(), sourceMap: new Map() };
            modelMap.set(model, entry);
        }
        entry.sources.add(s.source);
        entry.sessionCount++;
        entry.userRequests += s.userMessageCount;
        totalSessions++;
        totalUserRequests += s.userMessageCount;

        const rawWs = s.workspacePath ?? s.workspaceId;
        const wsKey = normalizeWsKey(rawWs);
        let wsEntry = entry.wsMap.get(wsKey);
        if (!wsEntry) {
            wsEntry = { displayPath: rawWs, total: 0, assistantMap: new Map() };
            entry.wsMap.set(wsKey, wsEntry);
        }
        wsEntry.total += s.userMessageCount;
        wsEntry.assistantMap.set(s.source, (wsEntry.assistantMap.get(s.source) ?? 0) + s.userMessageCount);

        const prevSess = entry.sessionMap.get(s.id);
        if (prevSess) { prevSess.userRequests += s.userMessageCount; }
        else { entry.sessionMap.set(s.id, { title: s.title, userRequests: s.userMessageCount }); }

        // Per-source tracking
        let srcEntry = entry.sourceMap.get(s.source);
        if (!srcEntry) {
            srcEntry = { sessionCount: 0, userRequests: 0, sessionMap: new Map() };
            entry.sourceMap.set(s.source, srcEntry);
        }
        srcEntry.sessionCount++;
        srcEntry.userRequests += s.userMessageCount;
        const prevSrcSess = srcEntry.sessionMap.get(s.id);
        if (prevSrcSess) { prevSrcSess.userRequests += s.userMessageCount; }
        else { srcEntry.sessionMap.set(s.id, { title: s.title, userRequests: s.userMessageCount }); }
    }

    const models: ModelEntry[] = [...modelMap.values()]
        .map((e) => {
            const workspaceBreakdown: WorkspaceUsage[] = [...e.wsMap.values()]
                .map((ws) => {
                    const assistantBreakdown: AssistantUsage[] = [...ws.assistantMap.entries()]
                        .map(([assistant, userRequests]) => ({ assistant, userRequests }))
                        .sort((a, b) => b.userRequests - a.userRequests);
                    return { workspace: ws.displayPath, userRequests: ws.total, assistantBreakdown };
                })
                .sort((a, b) => b.userRequests - a.userRequests);
            const sessionBreakdown: SessionUsage[] = [...e.sessionMap.entries()]
                .map(([sessionId, v]) => ({ sessionId, sessionTitle: v.title, userRequests: v.userRequests }))
                .sort((a, b) => b.userRequests - a.userRequests);
            const sourceBreakdown: SourceBreakdown[] = [...e.sourceMap.entries()]
                .map(([source, sv]) => ({
                    source,
                    sessionCount: sv.sessionCount,
                    userRequests: sv.userRequests,
                    percentage: totalUserRequests === 0
                        ? 0
                        : Math.round((sv.userRequests / totalUserRequests) * 10000) / 100,
                    sessionBreakdown: [...sv.sessionMap.entries()]
                        .map(([sessionId, v]) => ({ sessionId, sessionTitle: v.title, userRequests: v.userRequests }))
                        .sort((a, b) => b.userRequests - a.userRequests),
                }))
                .sort((a, b) => b.userRequests - a.userRequests);
            return {
                model: e.model,
                sources: [...e.sources],
                sessionCount: e.sessionCount,
                userRequests: e.userRequests,
                percentage: totalUserRequests === 0
                    ? 0
                    : Math.round((e.userRequests / totalUserRequests) * 10000) / 100,
                workspaceBreakdown,
                sessionBreakdown,
                sourceBreakdown,
            };
        })
        .sort((a, b) => b.userRequests - a.userRequests);

    return { from: fromStr, to: toStr, totalSessions, totalUserRequests, models };
}
