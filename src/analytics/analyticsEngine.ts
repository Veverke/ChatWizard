// src/analytics/analyticsEngine.ts

import { Session, SessionSource } from '../types/index';

/** Token-count callback — injected so tests can use a trivial counter */
export type CountTokensFn = (text: string, source: SessionSource) => number;

/** Per-session analytics */
export interface SessionMetrics {
    sessionId: string;
    sessionTitle: string;
    sessionSource: SessionSource;
    workspacePath?: string;
    updatedAt: string;
    userMessageCount: number;
    assistantMessageCount: number;
    totalMessageCount: number;
    userTokens: number;
    assistantTokens: number;
    totalTokens: number;
}

/** Activity aggregated per calendar day */
export interface DailyActivity {
    date: string;        // YYYY-MM-DD
    sessionCount: number;
    promptCount: number;
    tokenCount: number;
}

/** Activity aggregated per project/workspace */
export interface ProjectActivity {
    workspacePath: string;
    sessionCount: number;
    promptCount: number;
    tokenCount: number;
}

/** A frequently-used term from user prompts */
export interface TopTerm {
    term: string;
    count: number;
}

/** Top-level analytics output */
export interface AnalyticsData {
    totalSessions: number;
    totalPrompts: number;
    totalResponses: number;
    totalUserTokens: number;
    totalAssistantTokens: number;
    totalTokens: number;
    sessionCountsBySource: Record<string, number>;
    dailyActivity: DailyActivity[];      // sorted by date asc
    projectActivity: ProjectActivity[];  // sorted by tokenCount desc
    topTerms: TopTerm[];                 // top 20, sorted by count desc
    longestByMessages: SessionMetrics[]; // top 10 by totalMessageCount desc
    longestByTokens: SessionMetrics[];   // top 10 by totalTokens desc
    oldestDate: string;   // YYYY-MM-DD of the earliest session, or '' if no sessions
    newestDate: string;   // YYYY-MM-DD of the latest session, or '' if no sessions
    timeSpanDays: number; // calendar days between oldest and newest (inclusive), or 0
}

const STOP_WORDS = new Set([
    'the','and','for','are','but','not','you','all','can','her',
    'was','one','our','out','had','have','has','him','his','how',
    'its','let','may','she','who','use','that','this','with','from',
    'they','will','been','more','also','into','than','just','your',
]);

export function computeAnalytics(sessions: Session[], countTokens: CountTokensFn): AnalyticsData {
    const allMetrics: SessionMetrics[] = sessions.map(session => {
        let userMessageCount = 0;
        let assistantMessageCount = 0;
        let userTokens = 0;
        let assistantTokens = 0;

        for (const msg of session.messages) {
            if (msg.role === 'user') {
                userMessageCount++;
                userTokens += countTokens(msg.content, session.source);
            } else {
                assistantMessageCount++;
                assistantTokens += countTokens(msg.content, session.source);
            }
        }

        return {
            sessionId: session.id,
            sessionTitle: session.title,
            sessionSource: session.source,
            workspacePath: session.workspacePath,
            updatedAt: session.updatedAt,
            userMessageCount,
            assistantMessageCount,
            totalMessageCount: userMessageCount + assistantMessageCount,
            userTokens,
            assistantTokens,
            totalTokens: userTokens + assistantTokens,
        };
    });

    let totalPrompts = 0;
    let totalResponses = 0;
    let totalUserTokens = 0;
    let totalAssistantTokens = 0;
    const sessionCountsBySource: Record<string, number> = {
        copilot: 0, claude: 0, cline: 0, roocode: 0,
        cursor: 0, windsurf: 0, aider: 0, antigravity: 0,
    };

    for (const m of allMetrics) {
        totalPrompts += m.userMessageCount;
        totalResponses += m.assistantMessageCount;
        totalUserTokens += m.userTokens;
        totalAssistantTokens += m.assistantTokens;
    }
    for (const s of sessions) {
        sessionCountsBySource[s.source] = (sessionCountsBySource[s.source] || 0) + 1;
    }

    const totalTokens = totalUserTokens + totalAssistantTokens;

    // daily activity
    const dailyMap = new Map<string, DailyActivity>();
    for (const m of allMetrics) {
        const date = m.updatedAt.slice(0, 10);
        let entry = dailyMap.get(date);
        if (!entry) {
            entry = { date, sessionCount: 0, promptCount: 0, tokenCount: 0 };
            dailyMap.set(date, entry);
        }
        entry.sessionCount++;
        entry.promptCount += m.userMessageCount;
        entry.tokenCount += m.totalTokens;
    }
    const dailyActivity = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));

    // project activity
    const projectMap = new Map<string, ProjectActivity>();
    for (let i = 0; i < sessions.length; i++) {
        const session = sessions[i];
        const m = allMetrics[i];
        const key = session.workspacePath ?? session.workspaceId;
        let entry = projectMap.get(key);
        if (!entry) {
            entry = { workspacePath: key, sessionCount: 0, promptCount: 0, tokenCount: 0 };
            projectMap.set(key, entry);
        }
        entry.sessionCount++;
        entry.promptCount += m.userMessageCount;
        entry.tokenCount += m.totalTokens;
    }
    const projectActivity = [...projectMap.values()].sort((a, b) => b.tokenCount - a.tokenCount);

    // top terms
    const termFreq = new Map<string, number>();
    for (const session of sessions) {
        for (const msg of session.messages) {
            if (msg.role !== 'user') { continue; }
            const words = msg.content.split(/\s+/).filter(Boolean);
            for (const raw of words) {
                const word = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
                if (word.length < 3) { continue; }
                if (STOP_WORDS.has(word)) { continue; }
                termFreq.set(word, (termFreq.get(word) ?? 0) + 1);
            }
        }
    }
    const topTerms = [...termFreq.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 20)
        .map(([term, count]) => ({ term, count }));

    const longestByMessages = [...allMetrics]
        .sort((a, b) => b.totalMessageCount - a.totalMessageCount)
        .slice(0, 10);

    const longestByTokens = [...allMetrics]
        .sort((a, b) => b.totalTokens - a.totalTokens)
        .slice(0, 10);

    // time span
    let oldestDate = '';
    let newestDate = '';
    let timeSpanDays = 0;
    if (dailyActivity.length > 0) {
        oldestDate = dailyActivity[0].date;
        newestDate = dailyActivity[dailyActivity.length - 1].date;
        const msPerDay = 86_400_000;
        timeSpanDays = Math.round(
            (new Date(newestDate).getTime() - new Date(oldestDate).getTime()) / msPerDay
        ) + 1;
    }

    return {
        totalSessions: sessions.length,
        totalPrompts,
        totalResponses,
        totalUserTokens,
        totalAssistantTokens,
        totalTokens,
        sessionCountsBySource,
        dailyActivity,
        projectActivity,
        topTerms,
        longestByMessages,
        longestByTokens,
        oldestDate,
        newestDate,
        timeSpanDays,
    };
}