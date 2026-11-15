/**
 * test/unit/workspaceScope.test.ts
 *
 * `workspacePathsForIds` — maps the persisted ChatWizard workspace selection
 * (IDs) back to the folders it covers. The Commands view uses it to follow the
 * same scope as the Sessions view when no VS Code folder is open.
 */

import * as assert from 'assert';
import * as path from 'path';
import { ScopedWorkspace } from '../../src/types/index';
import { workspacePathsForIds } from '../../src/watcher/workspaceScope';

function ws(id: string, workspacePath: string, source: ScopedWorkspace['source'] = 'copilot'): ScopedWorkspace {
    return { id, source, workspacePath, storageDir: path.join('/tmp', id) };
}

suite('workspacePathsForIds', () => {
    const chatWizard = path.join('C:', 'Repos', 'Mine', 'ChatWizard');
    const analytics = path.join('C:', 'Repos', 'Mine', 'vscode-extension-analytics');

    // Copilot and Cursor report the same folder under the same hash id; Claude
    // reports a different id per folder.
    const available = [
        ws('hash-cw', chatWizard, 'copilot'),
        ws('hash-cw', chatWizard, 'cursor'),
        ws('hash-analytics', analytics, 'copilot'),
    ];

    test('maps the selected ids to their folder paths', () => {
        assert.deepStrictEqual(workspacePathsForIds(available, ['hash-analytics']), [analytics]);
    });

    test('one row per folder — sources sharing a folder collapse', () => {
        assert.deepStrictEqual(workspacePathsForIds(available, ['hash-cw', 'hash-cw']), [chatWizard]);
        assert.deepStrictEqual(
            workspacePathsForIds(available, ['hash-cw', 'hash-analytics']),
            [chatWizard, analytics]
        );
    });

    test('an empty or unknown selection contributes no paths', () => {
        assert.deepStrictEqual(workspacePathsForIds(available, []), []);
        assert.deepStrictEqual(workspacePathsForIds(available, ['not-a-workspace']), []);
        assert.deepStrictEqual(
            workspacePathsForIds([ws('hash-blank', '   ')], ['hash-blank']),
            [],
            'blank paths are skipped instead of scoping the view to nowhere'
        );
    });
});
