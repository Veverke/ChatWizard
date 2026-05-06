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
    readonly description = 'Answer a question using retrieved ChatWizard history context first.';
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
                'If no relevant context is found, state that clearly and then provide best-practice guidance.',
            ].join('\n');
            return { content: [{ type: 'text', text: fallbackPrompt }] };
        }

        const contextText = await runTool(this.getContextTool, { topic: question, limit: 8 });

        const prompt = [
            'You must answer the user question using the retrieved ChatWizard history context below first.',
            'If prior work exists, mention it explicitly before giving recommendations.',
            'If no relevant context is found, state that clearly and then provide best-practice guidance.',
            '',
            'Retrieved context:',
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
    readonly description = 'Troubleshoot an error by retrieving prior similar fixes from chat history first.';
    readonly arguments = [
        {
            name: 'error',
            description: 'Error message or short failure description.',
            required: false,
        },
    ];

    constructor(private readonly searchTool: IMcpTool) {}

    async render(args: Record<string, string>): Promise<McpToolResult> {
        const errorText = (args.error ?? '').trim();
        if (!errorText) {
            const fallbackPrompt = [
                'Use the user\'s current request in this same chat turn as the error/problem statement.',
                'Before troubleshooting, call `chatwizard_search` with that text to retrieve similar incidents.',
                'Open with the most relevant previous fix if one exists, then provide concrete resolution steps.',
            ].join('\n');
            return { content: [{ type: 'text', text: fallbackPrompt }] };
        }

        const searchText = await runTool(this.searchTool, { query: errorText, limit: 8 });

        const prompt = [
            'You must troubleshoot using the retrieved prior incidents first.',
            'Open with the most relevant previous fix if one exists, then provide a concrete step-by-step resolution.',
            '',
            'Retrieved similar incidents:',
            searchText || '(none)',
            '',
            `Current error/problem: ${errorText}`,
        ].join('\n');

        return { content: [{ type: 'text', text: prompt }] };
    }
}

/**
 * Slash prompt: orient to recent work before planning next steps.
 */
export class ContinueFromHistoryPrompt implements IMcpPrompt {
    readonly name = 'chatwizard.continueFromHistory';
    readonly description = 'Continue work by summarizing recent sessions and proposing next actions.';
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
