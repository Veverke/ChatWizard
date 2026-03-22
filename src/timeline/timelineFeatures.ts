// src/timeline/timelineFeatures.ts
// Pure helper functions for Timeline tab features (no vscode dependency).

import { TimelineEntry } from './timelineBuilder';

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface HeatMapCell {
    date: string;   // YYYY-MM-DD
    count: number;  // sessions that day (0 for empty days)
}

export interface WorkBurst {
    burstId: string;          // unique id, e.g. `burst-${startTimestamp}`
    date: string;             // YYYY-MM-DD of first (oldest) session in burst
    startTimestamp: number;   // ms epoch of oldest session
    endTimestamp: number;     // ms epoch of newest session
    durationMinutes: number;  // endTimestamp - startTimestamp in minutes
    sessionIds: string[];     // ordered oldest-first
    sources: Array<'copilot' | 'claude'>;  // deduped
    totalMessages: number;
    sessionCount: number;
}

export interface WeekTerms {
    weekKey: string;   // ISO week key, e.g. "2025-W03"
    terms: string[];   // top-3 terms for that week
}

export interface TimelineStats {
    activeDaysThisWeek: number;
    totalSessions: number;
    currentStreak: number;
    longestStreak: number;
    onThisDayLastMonth: TimelineEntry[];
}

// ── Stop words ────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
    'the','a','an','to','of','in','and','for','is','it','that','this','with','on',
    'i','you','we','how','do','can','my','me','what','why','get','when','are','was',
    'be','have','as','at','by','not','but','or','if','so','up','use','let','make',
    'add','all','into','from','more','will','your','like','just','one','its','has',
    'their','about','than','then','there','also','any','which','who','he','she',
    'they','him','her','our','am','im','using','used','want','need','help','try',
    'please','sure','okay','yes','no','ok','hi','hey','new','now','see','work',
]);

// ── ISO week helper ───────────────────────────────────────────────────────────

export function getISOWeekKey(ts: number): string {
    const d = new Date(ts);
    const day = d.getUTCDay() || 7; // 1=Mon … 7=Sun
    const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 4 - day));
    const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((thursday.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    return `${thursday.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// ── buildHeatMap ──────────────────────────────────────────────────────────────

/**
 * Build a calendar heat-map array with one cell per calendar day from the
 * earliest session date through today.  Empty days get count=0.
 * Returns cells sorted ascending (oldest first) — suitable for left-to-right rendering.
 */
export function buildHeatMap(entries: TimelineEntry[], today: Date = new Date()): HeatMapCell[] {
    if (entries.length === 0) { return []; }

    const countByDate = new Map<string, number>();
    for (const e of entries) {
        countByDate.set(e.date, (countByDate.get(e.date) ?? 0) + 1);
    }

    const todayStr = today.toISOString().slice(0, 10);
    // Find the min date among all entries
    let minDate = todayStr;
    for (const date of countByDate.keys()) {
        if (date < minDate) { minDate = date; }
    }

    const cells: HeatMapCell[] = [];
    const cursor = new Date(minDate + 'T00:00:00Z');
    const end = new Date(todayStr + 'T00:00:00Z');
    while (cursor <= end) {
        const dateStr = cursor.toISOString().slice(0, 10);
        cells.push({ date: dateStr, count: countByDate.get(dateStr) ?? 0 });
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return cells;
}

// ── buildWorkBursts ───────────────────────────────────────────────────────────

const BURST_GAP_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Cluster sessions that occur within a 2-hour window into "work bursts".
 * Input entries must be sorted newest-first (as returned by buildTimeline).
 * Returns bursts sorted newest-first.
 */
export function buildWorkBursts(entries: TimelineEntry[]): WorkBurst[] {
    if (entries.length === 0) { return []; }

    // Work oldest-first for grouping
    const oldestFirst = [...entries].reverse();

    const bursts: WorkBurst[] = [];
    let burstEntries: TimelineEntry[] = [oldestFirst[0]];

    for (let i = 1; i < oldestFirst.length; i++) {
        const prev = burstEntries[burstEntries.length - 1];
        const curr = oldestFirst[i];
        if (curr.timestamp - prev.timestamp <= BURST_GAP_MS) {
            burstEntries.push(curr);
        } else {
            bursts.push(makeBurst(burstEntries));
            burstEntries = [curr];
        }
    }
    bursts.push(makeBurst(burstEntries));

    // Return newest-first
    bursts.reverse();
    return bursts;
}

function makeBurst(entries: TimelineEntry[]): WorkBurst {
    const startTs = entries[0].timestamp;
    const endTs = entries[entries.length - 1].timestamp;
    const durationMinutes = Math.round((endTs - startTs) / 60000);
    const sources: Array<'copilot' | 'claude'> = [...new Set(entries.map(e => e.source))];
    const totalMessages = entries.reduce((s, e) => s + e.messageCount, 0);
    return {
        burstId: `burst-${startTs}`,
        date: entries[0].date,
        startTimestamp: startTs,
        endTimestamp: endTs,
        durationMinutes,
        sessionIds: entries.map(e => e.sessionId),
        sources,
        totalMessages,
        sessionCount: entries.length,
    };
}

// ── buildTopicDrift ───────────────────────────────────────────────────────────

/**
 * For each ISO week in the entry set, return the top-3 most frequent non-stop words
 * extracted from the firstPrompt fields.
 * Returns sorted oldest-first (chronological, left-to-right ribbon order).
 */
export function buildTopicDrift(entries: TimelineEntry[]): WeekTerms[] {
    if (entries.length === 0) { return []; }

    const weekMap = new Map<string, Map<string, number>>();

    for (const entry of entries) {
        const wk = getISOWeekKey(entry.timestamp);
        if (!weekMap.has(wk)) { weekMap.set(wk, new Map()); }
        const freqMap = weekMap.get(wk)!;

        const words = entry.firstPrompt.toLowerCase().split(/[\s\W]+/).filter(w => w.length >= 3 && !STOP_WORDS.has(w));
        for (const w of words) {
            freqMap.set(w, (freqMap.get(w) ?? 0) + 1);
        }
    }

    const result: WeekTerms[] = [];
    for (const [weekKey, freqMap] of weekMap) {
        const sorted = [...freqMap.entries()].sort((a, b) => b[1] - a[1]);
        result.push({ weekKey, terms: sorted.slice(0, 3).map(([t]) => t) });
    }

    // Sort oldest-first (lexicographic on "YYYY-Www" works correctly)
    result.sort((a, b) => a.weekKey < b.weekKey ? -1 : a.weekKey > b.weekKey ? 1 : 0);
    return result;
}

// ── buildTimelineStats ────────────────────────────────────────────────────────

/**
 * Compute summary stats: active days this week, total sessions, streaks, and
 * "on this day last month" entries.
 */
export function buildTimelineStats(entries: TimelineEntry[], today: Date = new Date()): TimelineStats {
    const totalSessions = entries.length;
    const todayStr = today.toISOString().slice(0, 10);

    // Build set of all occupied dates
    const occupiedDates = new Set<string>(entries.map(e => e.date));

    // Active days this week (Mon–Sun ISO week containing today)
    const dayOfWeek = today.getUTCDay() || 7; // 1=Mon…7=Sun
    let activeDaysThisWeek = 0;
    for (let d = 0; d < 7; d++) {
        const offset = d - (dayOfWeek - 1); // offset from Monday
        const candidate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset));
        const candidateStr = candidate.toISOString().slice(0, 10);
        if (candidateStr <= todayStr && occupiedDates.has(candidateStr)) {
            activeDaysThisWeek++;
        }
    }

    // Current streak (consecutive days ending today or yesterday)
    let currentStreak = 0;
    const cursor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    while (true) {
        const dateStr = cursor.toISOString().slice(0, 10);
        if (!occupiedDates.has(dateStr)) { break; }
        currentStreak++;
        cursor.setUTCDate(cursor.getUTCDate() - 1);
    }

    // Longest streak (linear scan over sorted dates)
    const sortedDates = [...occupiedDates].sort();
    let longestStreak = 0;
    let run = 0;
    for (let i = 0; i < sortedDates.length; i++) {
        if (i === 0) {
            run = 1;
        } else {
            const prev = new Date(sortedDates[i - 1] + 'T00:00:00Z');
            prev.setUTCDate(prev.getUTCDate() + 1);
            if (prev.toISOString().slice(0, 10) === sortedDates[i]) {
                run++;
            } else {
                run = 1;
            }
        }
        if (run > longestStreak) { longestStreak = run; }
    }

    // On this day last month
    const targetDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, today.getUTCDate()));
    // Guard against month overflow (e.g. March 31 → Feb 31 → Mar 3)
    const expectedMonth = today.getUTCMonth() === 0 ? 11 : today.getUTCMonth() - 1;
    let onThisDayLastMonth: TimelineEntry[] = [];
    if (targetDate.getUTCMonth() === expectedMonth) {
        const targetStr = targetDate.toISOString().slice(0, 10);
        onThisDayLastMonth = entries.filter(e => e.date === targetStr);
    }

    return { activeDaysThisWeek, totalSessions, currentStreak, longestStreak, onThisDayLastMonth };
}

// ── findFirstMatchingEntry ────────────────────────────────────────────────────

/**
 * Find the earliest (chronologically first) entry whose sessionTitle or firstPrompt
 * contains the given query (case-insensitive).
 * Entries must be sorted newest-first (as returned by buildTimeline).
 */
export function findFirstMatchingEntry(entries: TimelineEntry[], query: string): TimelineEntry | undefined {
    if (!query) { return undefined; }
    const q = query.toLowerCase();
    // Walk from oldest to newest (reverse of the array)
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.sessionTitle.toLowerCase().includes(q) || e.firstPrompt.toLowerCase().includes(q)) {
            return e;
        }
    }
    return undefined;
}
