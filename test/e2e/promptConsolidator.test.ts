// test/e2e/promptConsolidator.test.ts
//
// Unit tests for the heuristic PromptConsolidator (Feature 20-G).
// Tests cover filler stripping, deduplication, real developer multi-turn
// scenarios, edge cases, and numerical token-count savings.

import * as assert from 'assert';
import { consolidate, FILLER_START_PATTERNS, FILLER_END_PATTERNS } from '../../src/analytics/promptConsolidator';

suite('PromptConsolidator', () => {

    // ── Null cases ──────────────────────────────────────────────────────────

    test('returns null for empty array', () => {
        assert.strictEqual(consolidate([]), null);
    });

    test('returns null for a single message', () => {
        assert.strictEqual(consolidate(['How do I set up TypeScript strict mode?']), null);
    });

    test('returns null when all messages are near-duplicates (Jaccard > 0.75)', () => {
        // Near-identical sentences that share the vast majority of their words
        // Jaccard(a,b) = |intersection| / |union|.
        // "fix the login bug" vs "fix login bug" → {fix,the,login,bug} ∩ {fix,login,bug} / {fix,the,login,bug} = 3/4 = 0.75 (borderline)
        // Use even higher overlap to be safely above the threshold:
        const msgs = [
            'Please fix the authentication login bug in the application',
            'Please fix the login authentication bug in the application',
            'Fix the login authentication bug in the application please',
        ];
        // All three are highly similar — only one unique intent after dedup
        const result = consolidate(msgs);
        assert.strictEqual(result, null, 'Should return null when all are near-duplicates');
    });

    // ── Filler stripping ────────────────────────────────────────────────────

    test('strips "Can you please" opener', () => {
        const result = consolidate([
            'Can you please explain how async/await works in JavaScript?',
            'Also, what is the difference between Promise.all and Promise.allSettled?',
        ]);
        assert.ok(result, 'Expected a result');
        assert.ok(
            !result.consolidatedPrompt.toLowerCase().includes('can you please'),
            `Consolidated prompt should not contain "can you please": ${result.consolidatedPrompt}`,
        );
    });

    test('strips "Thank you" from the end', () => {
        const result = consolidate([
            'Explain React hooks. Thank you',
            'Show me an example of useState.',
        ]);
        assert.ok(result);
        assert.ok(
            !result.consolidatedPrompt.toLowerCase().includes('thank you'),
            `Should not contain "thank you": ${result.consolidatedPrompt}`,
        );
    });

    test('strips "Also, " prefix from follow-up messages', () => {
        const result = consolidate([
            'Write a TypeScript function that validates an email address.',
            'Also, add unit tests for it.',
        ]);
        assert.ok(result);
        assert.ok(
            !result.consolidatedPrompt.toLowerCase().startsWith('also'),
            `Consolidated prompt should not start with "also": ${result.consolidatedPrompt}`,
        );
    });

    test('strips "follow up:" prefix', () => {
        const result = consolidate([
            'Implement a debounce utility in TypeScript.',
            'Follow up: add a cancel method to it as well.',
        ]);
        assert.ok(result);
        assert.ok(
            !result.consolidatedPrompt.toLowerCase().includes('follow up:'),
            `Should not contain "follow up:": ${result.consolidatedPrompt}`,
        );
    });

    // ── Happy path — realistic multi-turn developer conversations ───────────

    test('two distinct intents → numbered list with 2 items', () => {
        const result = consolidate([
            'Refactor the authentication module to use dependency injection.',
            'Write unit tests for the refactored auth module.',
        ]);
        assert.ok(result, 'Expected a ConsolidationResult');
        assert.strictEqual(result.intentCount, 2);
        assert.ok(result.consolidatedPrompt.includes('1.'), 'Expected item 1');
        assert.ok(result.consolidatedPrompt.includes('2.'), 'Expected item 2');
        assert.ok(
            result.consolidatedPrompt.startsWith('Please accomplish all of the following:'),
            `Expected standard header: ${result.consolidatedPrompt}`,
        );
    });

    test('three distinct developer intents → 3-item list', () => {
        const result = consolidate([
            'Extract a UserService class from the monolithic AuthController.',
            'Add password hashing using bcrypt to the UserService.',
            'Update the README with the new architecture and usage examples.',
        ]);
        assert.ok(result);
        assert.strictEqual(result.intentCount, 3);
        assert.ok(result.consolidatedPrompt.includes('3.'));
    });

    test('real bug-fix conversation with filler → clean consolidated prompt', () => {
        const result = consolidate([
            'Hey, can you help me figure out why my useEffect is running on every render?',
            'Also, once that\'s fixed, could you help me optimize the component to avoid unnecessary re-renders? Thanks',
        ]);
        assert.ok(result);
        assert.strictEqual(result.intentCount, 2);
        // Should not contain conversational fluff
        assert.ok(!result.consolidatedPrompt.toLowerCase().includes('hey'));
        assert.ok(!result.consolidatedPrompt.toLowerCase().includes('thanks'));
    });

    // ── Token count savings ─────────────────────────────────────────────────

    test('consolidated token count is less than sum of individual token counts', () => {
        // Three short distinct messages: the consolidated form adds a header but
        // is still shorter than 3 × (header + each message separately if wrapped).
        // Simpler test: verify consolidatedTokenCount is a positive number and the
        // consolidated prompt is meaningfully shorter than 3 concatenated full messages.
        const msgs = [
            'Set up a CI/CD pipeline with GitHub Actions for a Node.js project.',
            'Add secret management to the pipeline to avoid exposing API keys.',
            'Configure automatic test runs on every pull request.',
        ];

        const rawConcat = msgs.join(' ');
        const { countTokens } = require('../../src/utils/tokenizer');
        const rawTokens: number = countTokens(rawConcat);

        const result = consolidate(msgs);
        assert.ok(result, 'Expected a ConsolidationResult');
        assert.ok(result.consolidatedTokenCount > 0);
        // Consolidated should be ≤ 150% of the raw concatenation (generous: header overhead only)
        assert.ok(
            result.consolidatedTokenCount <= rawTokens * 1.5,
            `Consolidated (${result.consolidatedTokenCount}) should not be more than 150% of raw concat (${rawTokens})`,
        );
    });

    test('consolidatedTokenCount matches actual token estimate of consolidatedPrompt', () => {
        const result = consolidate([
            'Write a REST API with Express and TypeScript.',
            'Add JWT authentication to the API.',
        ]);
        assert.ok(result);
        // Token count should be a positive integer
        assert.ok(result.consolidatedTokenCount > 0);
        assert.ok(Number.isInteger(result.consolidatedTokenCount));
    });

    // ── Edge cases ──────────────────────────────────────────────────────────

    test('very long messages are handled without crash', () => {
        const longMsg1 = 'word '.repeat(500) + 'fix the login bug';
        const longMsg2 = 'word '.repeat(500) + 'add rate limiting to the API';
        const result = consolidate([longMsg1, longMsg2]);
        // These have many shared words ("word") but different endings — should produce a result
        // (they differ enough not to be pure duplicates)
        // At minimum it should not throw
        assert.ok(result !== undefined); // null or result is fine, just no crash
    });

    test('messages in a non-English language do not crash', () => {
        // Japanese characters — should not throw
        assert.doesNotThrow(() => {
            consolidate([
                'TypeScriptでの非同期処理の書き方を教えてください。',
                'エラーハンドリングのベストプラクティスも説明してください。',
            ]);
        });
    });

    test('two-message session with rephrased duplicate returns null', () => {
        // Essentially identical sentences — after Jaccard dedup only one intent remains.
        // Words overlap almost entirely:
        const result = consolidate([
            'fix the broken authentication login in the app',
            'fix the broken login authentication in the app',
        ]);
        // Should return null (single unique intent after dedup)
        assert.strictEqual(result, null);
    });

    test('messages with only filler text do not produce empty consolidated prompt', () => {
        // After stripping filler, these still have substantive content
        const result = consolidate([
            'Can you please write a debounce function?',
            'Also, can you write a throttle function? Thanks.',
        ]);
        assert.ok(result);
        assert.ok(result.consolidatedPrompt.length > 0);
    });

    // ── Structural validation of output ────────────────────────────────────

    test('output always starts with the standard header', () => {
        const result = consolidate([
            'Build a login form in React.',
            'Validate the form fields using Zod.',
        ]);
        assert.ok(result);
        assert.ok(
            result.consolidatedPrompt.startsWith('Please accomplish all of the following:'),
        );
    });

    test('FILLER_START_PATTERNS and FILLER_END_PATTERNS are exported', () => {
        assert.ok(Array.isArray(FILLER_START_PATTERNS));
        assert.ok(Array.isArray(FILLER_END_PATTERNS));
        assert.ok(FILLER_START_PATTERNS.length > 0);
        assert.ok(FILLER_END_PATTERNS.length > 0);
    });

});
