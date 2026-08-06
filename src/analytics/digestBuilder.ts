// src/analytics/digestBuilder.ts
// Feature 26 — Workspace Digest / Standup Reports

import type { Session } from '../types/index';

export type DigestWindow = 'today' | 'thisWeek' | 'thisSprint';

export interface DigestEntry {
    sessionId: string;
    title: string;
    summary: string;      // from sidecar summary or first assistant message (fallback)
    branch?: string;
    date: string;
}

export interface DigestResult {
    entries: DigestEntry[];
    markdown: string;
}

/**
 * Returns the start of the current day in UTC (midnight).
 */
function startOfToday(now: Date): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Returns the most recent Monday in UTC (start of current ISO week).
 */
function startOfThisWeek(now: Date): Date {
    const day = now.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const daysBack = day === 0 ? 6 : day - 1; // Monday = 0 days back; Sunday = 6
    const monday = new Date(now);
    monday.setUTCDate(now.getUTCDate() - daysBack);
    monday.setUTCHours(0, 0, 0, 0);
    return monday;
}

/**
 * Returns the start of the current 2-week sprint window.
 * Sprints start on Monday; the current sprint start is the most recent Monday
 * that is on an even sprint boundary (week 0 of a 2-week cycle relative to epoch).
 *
 * Approximation: uses 2-week periods starting from 2024-01-01 (a Monday).
 */
function startOfThisSprint(now: Date): Date {
    const EPOCH = new Date('2024-01-01T00:00:00Z').getTime();
    const SPRINT_MS = 14 * 24 * 60 * 60 * 1000; // 2 weeks
    const elapsed = now.getTime() - EPOCH;
    const sprintStart = new Date(EPOCH + Math.floor(elapsed / SPRINT_MS) * SPRINT_MS);
    return sprintStart;
}

/**
 * Get the cutoff date for the given window.
 */
function getCutoff(window: DigestWindow, now: Date): Date {
    switch (window) {
        case 'today':     return startOfToday(now);
        case 'thisWeek':  return startOfThisWeek(now);
        case 'thisSprint': return startOfThisSprint(now);
    }
}

/**
 * Get a human-readable label for the window.
 */
function windowLabel(window: DigestWindow): string {
    switch (window) {
        case 'today':     return 'today';
        case 'thisWeek':  return 'this week';
        case 'thisSprint': return 'this sprint';
    }
}

/**
 * Get the summary for a session: use sidecar summary if available,
 * fall back to the first assistant message (truncated to 120 chars).
 */
function getSessionSummary(
    session: Session,
    sidecarSummary: string | undefined
): string {
    if (sidecarSummary) { return sidecarSummary; }

    const firstAssistant = session.messages.find(m => m.role === 'assistant');
    if (firstAssistant?.content) {
        const text = firstAssistant.content.replace(/```[\s\S]*?```/g, '[code]').trim();
        const firstLine = text.split('\n').find(l => l.trim().length > 0) ?? text;
        return firstLine.length > 120 ? firstLine.slice(0, 120) + '…' : firstLine;
    }

    return '(no summary available)';
}

/**
 * Build a standup-style digest from the given sessions for the specified time window.
 *
 * @param sessions   Array of sessions to consider (should be all indexed sessions).
 * @param window     Time window: 'today' | 'thisWeek' | 'thisSprint'.
 * @param now        Override for "now" (used in tests). Defaults to current time.
 * @param summaries  Optional map of sessionId → sidecar summary text.
 */
export function buildDigest(
    sessions: Session[],
    window: DigestWindow,
    now: Date = new Date(),
    summaries?: Map<string, string>
): DigestResult {
    const cutoff = getCutoff(window, now);

    // Filter sessions within the time window
    const filtered = sessions.filter(s => {
        const updatedAt = new Date(s.updatedAt);
        return !isNaN(updatedAt.getTime()) && updatedAt >= cutoff;
    });

    // Sort by updatedAt ascending (oldest first within the window)
    filtered.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

    // Build entries
    const entries: DigestEntry[] = filtered.map(s => ({
        sessionId: s.id,
        title: s.title,
        summary: getSessionSummary(s, summaries?.get(s.id)),
        branch: s.chronicleData?.branch ?? undefined,
        date: s.updatedAt.slice(0, 10),
    }));

    // Group by branch for the markdown output
    const branchGroups = new Map<string, DigestEntry[]>();
    for (const entry of entries) {
        const key = entry.branch ?? '(no branch)';
        const arr = branchGroups.get(key) ?? [];
        arr.push(entry);
        branchGroups.set(key, arr);
    }

    // Build markdown
    const lines: string[] = [
        `## What I worked on [${windowLabel(window)}]`,
        '',
    ];

    if (entries.length === 0) {
        lines.push('_No sessions found in the selected time window._');
    } else {
        for (const [branch, branchEntries] of branchGroups.entries()) {
            const count = branchEntries.length;
            lines.push(`### ${branch} (${count} session${count === 1 ? '' : 's'})`);
            for (const entry of branchEntries) {
                lines.push(`- **${entry.title}** — ${entry.summary}`);
            }
            lines.push('');
        }

        const dateStr = `${now.getUTCDate()} ${now.toLocaleString('en', { month: 'short' })} ${now.getUTCFullYear()}`;
        lines.push(`_Generated by ChatWizard · ${dateStr}_`);
    }

    return {
        entries,
        markdown: lines.join('\n'),
    };
}