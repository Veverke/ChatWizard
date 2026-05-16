import { IMcpPrompt, IMcpTool, McpToolInput, McpToolResult } from '../mcpContracts';
import { SessionIndex } from '../../index/sessionIndex';
import { isArchitectureQuery } from '../../utils/queryClassifier';

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
 * to answer the question or resolve the problem grounded in that context.
 */
export class QueryHistoryPrompt implements IMcpPrompt {
    readonly name = 'chatwizard.queryHistory';
    readonly description = 'Answer questions or troubleshoot using prior chat history';
    readonly arguments = [
        {
            name: 'query',
            description: 'Question, problem, or error to look up in chat history.',
            required: false,
        },
    ];

    constructor(
        private readonly getContextTool: IMcpTool,
        private readonly getSessionFullTool: IMcpTool,
    ) {}

    async render(args: Record<string, string>): Promise<McpToolResult> {
        const query = (args.query ?? '').trim();

        if (!query) {
            const fallbackPrompt = [
                'Use the user\'s current request in this same chat turn as the query.',
                'Before answering, call `chatwizard_get_context` with that request as topic.',
                'If prior work exists, mention it explicitly before giving recommendations.',
                'If no relevant context is found, output exactly "No relevant history found." and nothing more.',
            ].join('\n');
            return { content: [{ type: 'text', text: fallbackPrompt }] };
        }

        // Phase 2 — user confirmed sessions are relevant: consolidate and answer.
        if (query.startsWith('--continued ')) {
            const rest = query.slice('--continued '.length).trim();
            // Parse optional --refs <id1,id2,id3> suffix (appended by the Yes button).
            const refsMatch = rest.match(/\s+--refs\s+([^\s]+)$/);
            const refIds = refsMatch ? refsMatch[1].split(',').filter(Boolean) : [];
            const realQuery = refsMatch ? rest.slice(0, rest.length - refsMatch[0].length).trim() : rest;

            // Re-run the context tool to get passage-level excerpts for the confirmed sessions.
            // Using passage excerpts (not full session dumps) keeps the context focused and
            // ensures the LLM synthesises from all confirmed sessions rather than fixating on
            // whichever single session happens to have the most content.
            if (refIds.length > 0) {
                const cappedIds = refIds.slice(0, 3);
                const sessionContents: string[] = [];
                for (const id of cappedIds) {
                    const content = await runTool(this.getSessionFullTool, { sessionId: id });
                    // Exclude error responses and "session not found" messages
                    if (!content.toLowerCase().startsWith('error') && !content.toLowerCase().includes('session not found')) {
                        sessionContents.push(content);
                    }
                }

                // If all sessions failed, fall back to getContextTool
                if (sessionContents.length === 0) {
                    const contextText = await runTool(this.getContextTool, { topic: realQuery, limit: 8 });
                    const prompt = [
                        'The user confirmed that one or more of the previously listed sessions are relevant.',
                        'Using the sessions below, provide a direct answer or actionable resolution steps as appropriate.',
                        '',
                        'Sessions:',
                        contextText || '(none)',
                        '',
                        `Query: ${realQuery}`,
                    ].join('\n');
                    return { content: [{ type: 'text', text: prompt }] };
                }

                const mermaidHint = isArchitectureQuery(realQuery)
                    ? '\nIf the question concerns architecture, system design, component relationships, or data flow,\ninclude a Mermaid diagram (```mermaid ... ```) in your response to illustrate the structure\ndescribed in the sessions above. Use flowchart LR or sequenceDiagram as appropriate.'
                    : '';

                const consolidatedContent = sessionContents.join('\n\n---\n\n');
                const prompt = [
                    `The user confirmed that the following ${cappedIds.length} session(s) are relevant to their query.`,
                    'Synthesise ALL session content below into a single consolidated answer.',
                    'Cover what each session contributes — if sessions agree, unify; if they differ, note the nuance.',
                    'Avoid repeating the same advice across sessions. Be direct and actionable.',
                    mermaidHint,
                    '',
                    'Session content:',
                    consolidatedContent,
                    '',
                    `Original query: ${realQuery}`,
                ].filter(s => s !== undefined).join('\n');
                return { content: [{ type: 'text', text: prompt }] };
            }

            // Fallback: no session IDs provided or sessions not found in index.
            const contextText = await runTool(this.getContextTool, { topic: realQuery, limit: 8 });
            const mermaidHintFallback = isArchitectureQuery(realQuery)
                ? '\nIf the question concerns architecture, system design, component relationships, or data flow,\ninclude a Mermaid diagram (```mermaid ... ```) in your response to illustrate the structure\ndescribed in the sessions above. Use flowchart LR or sequenceDiagram as appropriate.'
                : '';
            const prompt = [
                'The user confirmed that one or more of the previously listed sessions are relevant.',
                'Using the sessions below, provide a direct answer or actionable resolution steps as appropriate.',
                'Cite each relevant session by title and date. Draw on its content to ground your response.',
                mermaidHintFallback,
                '',
                'Sessions:',
                contextText || '(none)',
                '',
                `Query: ${realQuery}`,
            ].filter(s => s !== undefined).join('\n');
            return { content: [{ type: 'text', text: prompt }] };
        }

        // Phase 2 — user said sessions are NOT relevant: answer from general knowledge only.
        if (query.startsWith('--general ')) {
            const realQuery = query.slice('--general '.length).trim();
            const prompt = [
                'No relevant history matches were found.',
                'Provide a thorough, practical answer or troubleshooting steps from general knowledge.',
                'Do not reference any chat history — this is purely general guidance.',
                '',
                `Query: ${realQuery}`,
            ].join('\n');
            return { content: [{ type: 'text', text: prompt }] };
        }

        // Phase 1 (default) — retrieve sessions and assess relevance. No answer yet.
        const contextText = await runTool(this.getContextTool, { topic: query, limit: 8 });
        const prompt = [
            'The sessions below were retrieved from the user\'s chat history as potential context.',
            'They may or may not be directly relevant — do not assume relevance.',
            '',
            'Output ONLY a JSON array of the 1-based position numbers of sessions relevant to the query.',
            'Examples: [1] means only the first session; [1,3] means first and third; [] means none relevant.',
            'A session is relevant if its Passage text has meaningful overlap with the query topic.',
            'Do NOT output any explanation, text, markdown, or code fences — ONLY the JSON array.',
            '',
            'IMPORTANT: Do NOT provide answers, fixes, or solutions at this stage.',
            '',
            'Retrieved sessions (may or may not be relevant):',
            contextText || '(none)',
            '',
            `Query: ${query}`,
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

    constructor(
        private readonly listRecentTool: IMcpTool,
        private readonly getContextTool: IMcpTool,
        private readonly sessionIndex?: SessionIndex,
    ) {}

    async render(args: Record<string, string>): Promise<McpToolResult> {
        const topic = (args.topic ?? '').trim();
        const recentText = await runTool(this.listRecentTool, { limit: 5 });
        const contextText = topic
            ? await runTool(this.getContextTool, { topic, limit: 5 })
            : '';

        // Look up Chronicle checkpoint data for the most recent Copilot session.
        let chronicleSection = '';
        let chronicleFooter = '';
        if (this.sessionIndex) {
            const copilotSessions = this.sessionIndex.getAllSummaries()
                .filter(s => s.source === 'copilot');
            const mostRecent = copilotSessions[0]; // already sorted by updatedAt desc
            if (mostRecent) {
                const full = this.sessionIndex.get(mostRecent.id);
                const chronicle = full?.chronicleData;
                if (chronicle) {
                    const parts: string[] = [];
                    if (chronicle.overview) { parts.push(`**Overview:** ${chronicle.overview}`); }
                    if (chronicle.workDone) { parts.push(`**Work done:** ${chronicle.workDone}`); }
                    if (chronicle.technicalDetails) { parts.push(`**Technical details:** ${chronicle.technicalDetails}`); }
                    if (chronicle.nextSteps) { parts.push(`**Suggested next steps:** ${chronicle.nextSteps}`); }
                    if (parts.length > 0) {
                        chronicleSection = [
                            '',
                            'Copilot Chronicle checkpoint for the most recent session:',
                            ...parts,
                        ].join('\n');
                        chronicleFooter = '\n\n*Chronicle checkpoint data provided by Copilot Chronicle.*';
                    }
                }
            }
        }

        const prompt = [
            'You are continuing an ongoing codebase session.',
            'First summarise the most recent relevant work from history, then propose the top 3 next actions.',
            '',
            'Recent sessions:',
            recentText || '(none)',
            chronicleSection,
            topic ? '' : '',
            topic ? `Topic focus: ${topic}` : '',
            topic ? 'Topic-specific context:' : '',
            topic ? (contextText || '(none)') : '',
            chronicleFooter,
        ].filter(s => s !== undefined && s !== null).join('\n');

        return { content: [{ type: 'text', text: prompt }] };
    }
}

/**
 * Slash prompt: surface reusable prompts from the user's prompt library.
 */
export class GetPromptsPrompt implements IMcpPrompt {
    readonly name = 'chatwizard.getPrompts';
    readonly description = 'Find reusable prompts from your chat history';
    readonly arguments = [
        {
            name: 'topic',
            description: 'Optional topic or context to rank prompts by relevance.',
            required: false,
        },
    ];

    constructor(
        private readonly getContextTool: IMcpTool,
        private readonly listRecentTool: IMcpTool,
    ) {}

    async render(args: Record<string, string>): Promise<McpToolResult> {
        const topic = (args.topic ?? '').trim();
        const recentText = await runTool(this.listRecentTool, { limit: 5 });
        const contextText = topic
            ? await runTool(this.getContextTool, { topic, limit: 8 })
            : '';

        const prompt = [
            'You are a prompt engineering assistant. Extract and surface the most reusable, high-quality prompts from the sessions below.',
            'A reusable prompt is a user message that asks for something broadly applicable — not overly specific to one debugging incident.',
            'For each prompt you surface, include: the verbatim text, the source session title, and a one-sentence description of its intent.',
            'Format as a numbered Markdown list.',
            '',
            'Recent sessions:',
            recentText || '(none)',
            topic ? `\nTopic filter: ${topic}` : '',
            topic ? '\nTopic-specific sessions:' : '',
            topic ? (contextText || '(none)') : '',
            '',
            'Return the top 10 reusable prompts, ranked by generality and reusability.',
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
        command: 'queryHistory',
        description: 'Answer questions or troubleshoot using prior chat history',
        argName: 'query',
    },
    {
        command: 'continueFromHistory',
        description: 'Continue from recent sessions',
        argName: 'topic',
    },
    {
        command: 'getPrompts',
        description: 'Find reusable prompts from your chat history',
        argName: 'topic',
    },
];
