import { defineConfig } from '@vscode/test-cli';

// VSCODE_VERSION is set by the CI matrix (stable | insiders).
// Locally it defaults to 'stable'.
const version = process.env['VSCODE_VERSION'] ?? 'stable';

export default defineConfig({
    tests: [
        {
            version,
            files: ['out/test/e2e/*.test.js', 'out/test/e2e/mcp/**/*.test.js'],
            mocha: {
                ui: 'tdd',
                color: true,
                timeout: 10000,
            },
        },
        {
            version,
            files: ['out/test/unit/*.test.js'],
            mocha: {
                ui: 'tdd',
                color: true,
                timeout: 10000,
            },
        },
    ],
    coverage: {
        exclude: [
            '**/dist/**',
            '**/watcher/fileWatcher.ts',
            '**/mcp/chatParticipant.ts',
            '**/timeline/timelineViewProvider.ts',
            '**/watcher/configPaths.ts',
            '**/mcp/tools/getContextTool.ts',
            '**/mcp/mcpServer.ts',
            '**/parsers/cursor.ts',
            '**/parsers/copilot.ts',
            '**/parsers/antigravity.ts',
            '**/readers/copilotWorkspace.ts',
        ],
    },
});
