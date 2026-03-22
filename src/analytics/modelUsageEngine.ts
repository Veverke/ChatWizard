// src/analytics/modelUsageEngine.ts

import { SessionSummary, SessionSource, ModelEntry, ModelUsageData, WorkspaceUsage, SessionUsage } from '../types/index';
import { friendlyModelName } from './modelNames';

function toDateStr(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function computeModelUsage(
    summaries: SessionSummary[],
    from: Date,
    to: Date
): ModelUsageData {
    const fromStr = toDateStr(from);
    const toStr = toDateStr(to);

    // Key = "source::model" so the same model name used via different accounts stays separate
    const modelMap = new Map<string, {
        source: SessionSource;
        model: string;
        sessionCount: number;
        userRequests: number;
        wsMap: Map<string, number>;  // workspace label → userRequests
        sessionMap: Map<string, { title: string; userRequests: number }>;  // sessionId → {title, userRequests}
    }>();
    let totalSessions = 0;
    let totalUserRequests = 0;

    for (const s of summaries) {
        const dateStr = s.updatedAt.slice(0, 10);
        if (dateStr < fromStr || dateStr > toStr) { continue; }

        const model = friendlyModelName(s.model);
        const key = `${s.source}::${model}`;
        let entry = modelMap.get(key);
        if (!entry) {
            entry = { source: s.source, model, sessionCount: 0, userRequests: 0, wsMap: new Map(), sessionMap: new Map() };
            modelMap.set(key, entry);
        }
        entry.sessionCount++;
        entry.userRequests += s.userMessageCount;
        totalSessions++;
        totalUserRequests += s.userMessageCount;

        const wsLabel = s.workspacePath ?? s.workspaceId;
        entry.wsMap.set(wsLabel, (entry.wsMap.get(wsLabel) ?? 0) + s.userMessageCount);

        const prevSess = entry.sessionMap.get(s.id);
        if (prevSess) { prevSess.userRequests += s.userMessageCount; }
        else { entry.sessionMap.set(s.id, { title: s.title, userRequests: s.userMessageCount }); }
    }

    const models: ModelEntry[] = [...modelMap.values()]
        .map((e) => {
            const workspaceBreakdown: WorkspaceUsage[] = [...e.wsMap.entries()]
                .map(([workspace, userRequests]) => ({ workspace, userRequests }))
                .sort((a, b) => b.userRequests - a.userRequests);
            const sessionBreakdown: SessionUsage[] = [...e.sessionMap.entries()]
                .map(([sessionId, v]) => ({ sessionId, sessionTitle: v.title, userRequests: v.userRequests }))
                .sort((a, b) => b.userRequests - a.userRequests);
            return {
                model: e.model,
                source: e.source,
                sessionCount: e.sessionCount,
                userRequests: e.userRequests,
                percentage: totalUserRequests === 0
                    ? 0
                    : Math.round((e.userRequests / totalUserRequests) * 10000) / 100,
                workspaceBreakdown,
                sessionBreakdown,
            };
        })
        .sort((a, b) => b.userRequests - a.userRequests);

    return { from: fromStr, to: toStr, totalSessions, totalUserRequests, models };
}
