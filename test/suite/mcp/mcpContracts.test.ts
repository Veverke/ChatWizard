import * as assert from 'assert';
import {
    McpToolInput,
    McpToolResult,
    IMcpTool,
    IMcpServer,
    McpPromptArgument,
    IMcpPrompt
} from '../../../src/mcp/mcpContracts';
import { McpServerConfig } from '../../../src/types/index';

suite('McpContracts', () => {

    suite('McpToolResult shape', () => {
        test('minimal valid result has content array with text items', () => {
            const result: McpToolResult = {
                content: [{ type: 'text', text: 'hello' }]
            };
            assert.strictEqual(result.content.length, 1);
            assert.strictEqual(result.content[0].type, 'text');
            assert.strictEqual(result.content[0].text, 'hello');
            assert.strictEqual(result.isError, undefined);
        });

        test('error result sets isError flag', () => {
            const result: McpToolResult = {
                content: [{ type: 'text', text: 'something went wrong' }],
                isError: true
            };
            assert.strictEqual(result.isError, true);
        });

        test('result may contain multiple content items', () => {
            const result: McpToolResult = {
                content: [
                    { type: 'text', text: 'line 1' },
                    { type: 'text', text: 'line 2' }
                ]
            };
            assert.strictEqual(result.content.length, 2);
        });
    });

    suite('McpToolInput shape', () => {
        test('accepts arbitrary string keys', () => {
            const input: McpToolInput = { query: 'test', limit: 10 };
            assert.strictEqual(input['query'], 'test');
            assert.strictEqual(input['limit'], 10);
        });

        test('accepts empty input', () => {
            const input: McpToolInput = {};
            assert.strictEqual(Object.keys(input).length, 0);
        });
    });

    suite('IMcpTool contract', () => {
        test('a concrete implementation satisfies the interface', async () => {
            const tool: IMcpTool = {
                name: 'test_tool',
                description: 'A test tool',
                inputSchema: { type: 'object', properties: {} },
                async execute(_input: McpToolInput): Promise<McpToolResult> {
                    return { content: [{ type: 'text', text: 'ok' }] };
                }
            };

            assert.strictEqual(tool.name, 'test_tool');
            assert.strictEqual(tool.description, 'A test tool');
            assert.ok(tool.inputSchema);

            const result = await tool.execute({});
            assert.strictEqual(result.content[0].text, 'ok');
        });
    });

    suite('IMcpServer contract', () => {
        test('a concrete stub satisfies the interface', async () => {
            let running = false;
            const server: IMcpServer = {
                get isRunning() { return running; },
                get port() { return 6789; },
                async start() { running = true; },
                async stop() { running = false; }
            };

            assert.strictEqual(server.isRunning, false);
            assert.strictEqual(server.port, 6789);

            await server.start();
            assert.strictEqual(server.isRunning, true);

            await server.stop();
            assert.strictEqual(server.isRunning, false);
        });
    });

    suite('McpServerConfig shape', () => {
        test('has required fields with correct types', () => {
            const config: McpServerConfig = {
                enabled: true,
                port: 6789,
                tokenPath: '/some/path/mcp-token.txt'
            };
            assert.strictEqual(typeof config.enabled, 'boolean');
            assert.strictEqual(typeof config.port, 'number');
            assert.strictEqual(typeof config.tokenPath, 'string');
        });

        test('default-like config has enabled false and port 6789', () => {
            const config: McpServerConfig = {
                enabled: false,
                port: 6789,
                tokenPath: ''
            };
            assert.strictEqual(config.enabled, false);
            assert.strictEqual(config.port, 6789);
        });
    });

    suite('IMcpPrompt contract', () => {
        test('a concrete implementation satisfies the interface', async () => {
            const arg: McpPromptArgument = {
                name: 'topic',
                description: 'The topic to search for',
                required: true
            };
            const prompt: IMcpPrompt = {
                name: 'test_prompt',
                description: 'A test prompt',
                arguments: [arg],
                async render(args: Record<string, string>): Promise<McpToolResult> {
                    return { content: [{ type: 'text', text: `topic: ${args['topic']}` }] };
                }
            };

            assert.strictEqual(prompt.name, 'test_prompt');
            assert.strictEqual(prompt.arguments.length, 1);
            assert.strictEqual(prompt.arguments[0].required, true);

            const result = await prompt.render({ topic: 'caching' });
            assert.strictEqual(result.content[0].text, 'topic: caching');
        });
    });
});
