import { IMcpPrompt, IMcpTool, McpToolInput, McpToolResult } from '../mcpContracts';

function extractText(result: McpToolResult): string {
    return result.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n\n')
        .trim();
}

async function runTool(tool: IMcpTool, input: McpToolInput): Promise<string> {
    const result = await tool.execute(input);
    return extractText(result);
}

/**
 * Slash prompt: retrieves relevant historical context first, then asks the model
 * to answer the supplied question grounded in that context.
 */
export class ContextAnswerPrompt implements IMcpPrompt {
    readonly name = 'chatwizard.answerFromHistory';
    readonly description = 'Answer from chat history';
    readonly arguments = [
        {
            name: 'question',
            description: 'The question to answer using historical context.',
            required: false,
        },
    ];

    constructor(private readonly getContextTool: IMcpTool) {}

    async render(args: Record<string, string>): Promise<McpToolResult> {
        const question = (args.question ?? '').trim();
        if (!question) {
            const fallbackPrompt = [
                'Use the user\'s current request in this same chat turn as the question.',
                'Before answering, call `chatwizard_get_context` with that request as topic.',
                'If prior work exists, mention it explicitly before giving recommendations.',
                'If no relevant context is found, output exactly "No relevant history found." and nothing more.',
            ].join('\n');
            return { content: [{ type: 'text', text: fallbackPrompt }] };
        }

        // Phase 2 — user confirmed sessions are relevant: answer grounded in history.
        if (question.startsWith('--continued ')) {
            const realQuestion = question.slice('--continued '.length).trim();
            const contextText = await runTool(this.getContextTool, { topic: realQuestion, limit: 8 });
            const prompt = [
                'The user confirmed that one or more of the previously listed sessions are relevant to their question.',
                'Using the sessions below, provide a direct and complete answer.',
                'Cite each relevant session by title and date. Draw on its content to ground your answer.',
                '',
                'Sessions:',
                contextText || '(none)',
                '',
                `User question: ${realQuestion}`,
            ].join('\n');
            return { content: [{ type: 'text', text: prompt }] };
        }

        // Phase 2 — user said sessions are NOT relevant: answer from general knowledge only.
        if (question.startsWith('--general ')) {
            const realQuestion = question.slice('--general '.length).trim();
            const prompt = [
                'No relevant history matches were found for this question.',
                'Provide a thorough, practical best-practice answer from general knowledge.',
                'Do not reference any chat history — this is purely general guidance.',
                '',
                `Question: ${realQuestion}`,
            ].join('\n');
            return { content: [{ type: 'text', text: prompt }] };
        }

        // Phase 1 (default) — retrieve sessions and assess relevance. No direct answer yet.
        const contextText = await runTool(this.getContextTool, { topic: question, limit: 8 });
        const prompt = [
            'The sessions below were retrieved from the user\'s chat history as potential context for the question.',
            'They may or may not directly answer it — do not assume relevance.',
            '',
            'The session list is already displayed to the user in a table — do NOT re-list or describe each session.',
            'Only provide a relevance assessment using these strict rules:',
            '  \u2022 Only mention sessions that are clearly relevant OR potentially relevant to the question.',
            '  \u2022 For each such session: state its title and briefly explain why it is relevant.',
            '  \u2022 Do NOT mention, reference, or comment on sessions that are unrelated — skip them silently.',
            '  \u2022 If NO session has any connection to the question: output exactly "No relevant history found." and nothing more.',
            '  \u2022 Do NOT say things like "appears unrelated", "is not relevant", or "has no connection" about any session.',
            '',
            'IMPORTANT: Do NOT answer the question directly at this stage.',
            'The user will indicate whether the sessions are relevant before you answer.',
            '',
            'Retrieved sessions (may or may not be relevant):',
            contextText || '(none)',
            '',
            `User question: ${question}`,
        ].join('\n');

        return { content: [{ type: 'text', text: prompt }] };
    }
}

/**
 * Slash prompt: resolves a debugging/error question by searching historical fixes first.
 */
export class DebugWithHistoryPrompt implements IMcpPrompt {
    readonly name = 'chatwizard.troubleshootFromHistory';
    readonly description = 'Troubleshoot using prior chat history';
    readonly arguments = [
        {
            name: 'error',
            description: 'Error message or short failure description.',
            required: false,
        },
    ];

    constructor(private readonly searchTool: IMcpTool) {}

    async render(args: Record<string, string>): Promise<McpToolResult> {
        const raw = (args.error ?? '').trim();

        if (!raw) {
            const fallbackPrompt = [
                'Use the user\'s current request in this same chat turn as the error/problem statement.',
                'Before troubleshooting, call `chatwizard_search` with that text to retrieve similar incidents.',
                'Open with the most relevant previous fix if one exists, then provide concrete resolution steps.',
            ].join('\n');
            return { content: [{ type: 'text', text: fallbackPrompt }] };
        }

        // Phase 2 — user confirmed sessions are relevant: summarise solutions from history.
        if (raw.startsWith('--continued ')) {
            const errorText = raw.slice('--continued '.length).trim();
            const searchText = await runTool(this.searchTool, { query: errorText, limit: 8 });
            const prompt = [
                'The user confirmed that one or more of the previously listed sessions are relevant to their current error.',
                'Using the sessions below, provide a concise summary of what was done to resolve the issue.',
                'Cite each relevant session by title and date. Present the applied fix as actionable steps.',
                '',
                'Sessions:',
                searchText || '(none)',
                '',
                `Error/problem: ${errorText}`,
            ].join('\n');
            return { content: [{ type: 'text', text: prompt }] };
        }

        // Phase 2 — user said sessions are NOT relevant: provide generic troubleshooting only.
        if (raw.startsWith('--generic ')) {
            const errorText = raw.slice('--generic '.length).trim();
            const prompt = [
                'Given no relevant history matches were found, below are general recommendations for the problem the user is facing.',
                'Provide practical, step-by-step generic troubleshooting guidance.',
                'Do not reference any chat history — this is purely general best-practice guidance.',
                '',
                `Problem: ${errorText}`,
            ].join('\n');
            return { content: [{ type: 'text', text: prompt }] };
        }

        // Phase 1 (default) — retrieve sessions and assess relevance only. No listing, no solutions.
        const searchText = await runTool(this.searchTool, { query: raw, limit: 8 });
        const prompt = [
            'The sessions below were retrieved from the user\'s chat history as potential matches for the current error.',
            'They may or may not be directly relevant — do not assume relevance.',
            '',
            'The session list is already displayed to the user in a table — do NOT re-list or describe each session.',
            'Only provide a relevance assessment using these strict rules:',
            '  \u2022 Only mention sessions that are clearly relevant OR potentially relevant to the current error.',
            '  \u2022 For each such session: state its title and briefly explain the connection (same symptom, technology, or root cause).',
            '  \u2022 Do NOT mention, reference, or comment on sessions that are unrelated — skip them silently.',
            '  \u2022 If NO session has any connection to the error: respond only with:',
            '    "No relevant history found. Consider adding more details (stack trace, service name, technology) to increase the chances of finding a match if you are confident one exists in your chat history."',
            '  \u2022 Do NOT say things like "appears unrelated", "is not relevant", or "has no connection" about any session.',
            '',
            'IMPORTANT: Do NOT provide troubleshooting steps, solutions, or fixes at this stage.',
            'The user will indicate whether the sessions are relevant before proceeding.',
            '',
            'Retrieved sessions (may or may not be relevant):',
            searchText || '(none)',
            '',
            `Current error/problem: ${raw}`,
        ].join('\n');

        return { content: [{ type: 'text', text: prompt }] };
    }
}

/**
 * Slash prompt: orient to recent work before planning next steps.
 */
export class ContinueFromHistoryPrompt implements IMcpPrompt {
    readonly name = 'chatwizard.continueFromHistory';
    readonly description = 'Continue from recent sessions';
    readonly arguments = [
        {
            name: 'topic',
            description: 'Optional focus topic to bias continuation suggestions.',
            required: false,
        },
    ];

    constructor(private readonly listRecentTool: IMcpTool, private readonly getContextTool: IMcpTool) {}

    async render(args: Record<string, string>): Promise<McpToolResult> {
        const topic = (args.topic ?? '').trim();
        const recentText = await runTool(this.listRecentTool, { limit: 5 });
        const contextText = topic
            ? await runTool(this.getContextTool, { topic, limit: 5 })
            : '';

        const prompt = [
            'You are continuing an ongoing codebase session.',
            'First summarise the most recent relevant work from history, then propose the top 3 next actions.',
            '',
            'Recent sessions:',
            recentText || '(none)',
            topic ? '' : '',
            topic ? `Topic focus: ${topic}` : '',
            topic ? 'Topic-specific context:' : '',
            topic ? (contextText || '(none)') : '',
        ].filter(Boolean).join('\n');

        return { content: [{ type: 'text', text: prompt }] };
    }
}

// ---------------------------------------------------------------------------
// Single source of truth for slash-command metadata.
//
// The VS Code chat participant (src/mcp/chatParticipant.ts) reads this at
// runtime to map `/command` → IMcpPrompt.render().  The static package.json
// `contributes.chatParticipants.commands` array MUST be kept in sync: if you
// add, remove, or rename an entry here, update package.json accordingly.
// ---------------------------------------------------------------------------
export const PROMPT_DEFS: ReadonlyArray<{
    /** Short name without the 'chatwizard.' prefix — matches package.json slashCommand name */
    readonly command: string;
    readonly description: string;
    /** Name of the first (and only) argument populated from the user's free-form text */
    readonly argName: string;
}> = [
    {
        command: 'answerFromHistory',
        description: 'Answer from chat history',
        argName: 'question',
    },
    {
        command: 'troubleshootFromHistory',
        description: 'Troubleshoot using prior chat history',
        argName: 'error',
    },
    {
        command: 'continueFromHistory',
        description: 'Continue from recent sessions',
        argName: 'topic',
    },
];
