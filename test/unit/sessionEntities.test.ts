/**
 * test/unit/sessionEntities.test.ts
 *
 * Unit tests for the entity dropdown model behind the session reader's
 * Entities row: an entity-type dropdown (sorted alphabetically) and a
 * value dropdown that lists the entities of the selected type (also sorted).
 * Semantic `[type] value` entities are split into one type per sub-type and
 * their `[type]` marker is stripped from the values shown/searched.
 */

import * as assert from 'assert';
import {
    buildEntityTypeGroups,
    compareAlphabetically,
    normalizeEntityValues,
    parseSemanticValue,
    semanticTypeLabel,
} from '../../src/views/sessionEntities';
import { SessionWebviewPanel } from '../../src/views/sessionWebviewPanel';
import type { ExtractedEntities } from '../../src/types/index';

function entities(overrides?: Partial<ExtractedEntities>): ExtractedEntities {
    return {
        filePaths: [],
        functionNames: [],
        errors: [],
        decisions: [],
        ...overrides,
    };
}

suite('sessionEntities – entity dropdown model', () => {
    suite('normalizeEntityValues', () => {
        test('returns an empty array for missing or empty input', () => {
            assert.deepStrictEqual(normalizeEntityValues(undefined), []);
            assert.deepStrictEqual(normalizeEntityValues(null), []);
            assert.deepStrictEqual(normalizeEntityValues([]), []);
        });

        test('sorts values alphabetically, case-insensitively', () => {
            assert.deepStrictEqual(
                normalizeEntityValues(['zeta.ts', 'Alpha.ts', 'beta.ts']),
                ['Alpha.ts', 'beta.ts', 'zeta.ts']
            );
        });

        test('trims values and drops blanks', () => {
            assert.deepStrictEqual(
                normalizeEntityValues(['  b.ts ', '', '   ', 'a.ts']),
                ['a.ts', 'b.ts']
            );
        });

        test('de-duplicates case-insensitively, keeping the first spelling', () => {
            assert.deepStrictEqual(normalizeEntityValues(['Foo()', 'foo()', 'FOO()']), ['Foo()']);
        });
    });

    suite('compareAlphabetically', () => {
        test('compares case-insensitively', () => {
            assert.ok(compareAlphabetically('alpha', 'Beta') < 0);
            assert.ok(compareAlphabetically('Beta', 'alpha') > 0);
        });

        test('returns 0 for equal values', () => {
            assert.strictEqual(compareAlphabetically('Files', 'Files'), 0);
        });
    });

    suite('parseSemanticValue', () => {
        test('splits a leading [type] marker from the value', () => {
            assert.deepStrictEqual(parseSemanticValue('[tool] Docker'), { type: 'tool', value: 'Docker' });
        });

        test('is case-insensitive and trims surrounding whitespace', () => {
            assert.deepStrictEqual(parseSemanticValue('  [TOOL]   Docker  '), { type: 'tool', value: 'Docker' });
        });

        test('returns unprefixed values untouched', () => {
            assert.deepStrictEqual(parseSemanticValue('OAuth 2.0'), { type: null, value: 'OAuth 2.0' });
        });

        test('supports multi-word types', () => {
            assert.deepStrictEqual(parseSemanticValue('[build system] Nx'), { type: 'build system', value: 'Nx' });
        });
    });

    suite('semanticTypeLabel', () => {
        test('maps the LLM sub-types to plural labels', () => {
            assert.strictEqual(semanticTypeLabel('framework'), 'Frameworks');
            assert.strictEqual(semanticTypeLabel('api'), 'APIs');
            assert.strictEqual(semanticTypeLabel('concept'), 'Concepts');
            assert.strictEqual(semanticTypeLabel('tool'), 'Tools');
            assert.strictEqual(semanticTypeLabel('language'), 'Languages');
        });

        test('accepts already-plural markers', () => {
            assert.strictEqual(semanticTypeLabel('tools'), 'Tools');
            assert.strictEqual(semanticTypeLabel('apis'), 'APIs');
        });

        test('pluralizes unknown types and title-cases them', () => {
            assert.strictEqual(semanticTypeLabel('database'), 'Databases');
            assert.strictEqual(semanticTypeLabel('library'), 'Libraries');
        });

        test('falls back to Concepts without a marker', () => {
            assert.strictEqual(semanticTypeLabel(null), 'Concepts');
            assert.strictEqual(semanticTypeLabel(undefined), 'Concepts');
            assert.strictEqual(semanticTypeLabel(''), 'Concepts');
        });
    });

    suite('buildEntityTypeGroups', () => {
        test('returns no groups when there are no entities', () => {
            assert.deepStrictEqual(buildEntityTypeGroups(undefined), []);
            assert.deepStrictEqual(buildEntityTypeGroups(null), []);
            assert.deepStrictEqual(buildEntityTypeGroups(entities()), []);
        });

        test('sorts entity types alphabetically by label', () => {
            const groups = buildEntityTypeGroups(entities({
                filePaths: ['b.ts'],
                functionNames: ['fn'],
                errors: ['TypeError'],
                decisions: ['we chose X'],
                uris: ['https://example.com'],
                semantic: ['GraphQL'],
            }));
            assert.deepStrictEqual(
                groups.map(g => g.label),
                ['Concepts', 'Decisions', 'Errors', 'Files', 'Functions', 'Uris']
            );
        });

        test('maps each label back to its ExtractedEntities field', () => {
            const groups = buildEntityTypeGroups(entities({
                semantic: ['GraphQL'],
                filePaths: ['src/a.ts'],
            }));
            assert.deepStrictEqual(groups.map(g => g.key), ['semantic:concept', 'filePaths']);
        });

        test('only includes entity types that have values', () => {
            const groups = buildEntityTypeGroups(entities({ filePaths: ['a.ts'] }));
            assert.strictEqual(groups.length, 1);
            assert.strictEqual(groups[0].label, 'Files');
        });

        test('gives URIs their own type, with sorted values', () => {
            const groups = buildEntityTypeGroups(entities({
                uris: ['https://b.example/docs', 'http://a.example'],
            }));
            assert.strictEqual(groups.length, 1);
            assert.strictEqual(groups[0].label, 'Uris');
            assert.strictEqual(groups[0].key, 'uris');
            assert.deepStrictEqual(groups[0].items, ['http://a.example', 'https://b.example/docs']);
        });

        test('sorts the values inside each type alphabetically', () => {
            const groups = buildEntityTypeGroups(entities({
                filePaths: ['src/zeta.ts', 'src/Alpha.ts', 'package.json'],
            }));
            assert.deepStrictEqual(groups[0].items, ['package.json', 'src/Alpha.ts', 'src/zeta.ts']);
        });

        test('includes the Concepts group when the LLM pass added semantic entities', () => {
            const groups = buildEntityTypeGroups(entities({ semantic: ['React', 'ASP.NET'] }));
            assert.strictEqual(groups.length, 1);
            assert.strictEqual(groups[0].label, 'Concepts');
            assert.deepStrictEqual(groups[0].items, ['ASP.NET', 'React']);
        });

        test('splits `[type] value` entities into one group per sub-type', () => {
            const groups = buildEntityTypeGroups(entities({
                semantic: [
                    '[framework] React',
                    '[api] REST /api/users',
                    '[concept] event sourcing',
                    '[tool] Docker',
                    '[language] TypeScript',
                ],
            }));
            assert.deepStrictEqual(
                groups.map(g => g.label),
                ['APIs', 'Concepts', 'Frameworks', 'Languages', 'Tools']
            );
        });

        test('strips the `[type]` marker from the dropdown values', () => {
            const groups = buildEntityTypeGroups(entities({
                semantic: ['[concept] xxxx', '[tool] yyyy', '[language] zzzz'],
            }));
            const byLabel = new Map(groups.map(g => [g.label, g.items]));

            assert.deepStrictEqual(byLabel.get('Concepts'), ['xxxx']);
            assert.deepStrictEqual(byLabel.get('Tools'), ['yyyy']);
            assert.deepStrictEqual(byLabel.get('Languages'), ['zzzz']);
            for (const group of groups) {
                for (const item of group.items) {
                    assert.ok(!item.startsWith('['), `value must not carry its [type] marker: ${item}`);
                }
            }
        });

        test('sorts sub-type labels and their values alphabetically', () => {
            const groups = buildEntityTypeGroups(entities({
                semantic: [
                    '[language] TypeScript',
                    '[language] C#',
                    '[tool] Webpack',
                    '[tool] Docker',
                ],
            }));
            assert.deepStrictEqual(groups.map(g => g.label), ['Languages', 'Tools']);
            assert.deepStrictEqual(groups[0].items, ['C#', 'TypeScript']);
            assert.deepStrictEqual(groups[1].items, ['Docker', 'Webpack']);
        });

        test('merges values that differ only by their `[type]` marker', () => {
            const groups = buildEntityTypeGroups(entities({ semantic: ['[concept] React', 'React'] }));
            assert.strictEqual(groups.length, 1);
            assert.strictEqual(groups[0].label, 'Concepts');
            assert.deepStrictEqual(groups[0].items, ['React']);
        });

        test('gives unknown `[type]` markers their own pluralized group', () => {
            const groups = buildEntityTypeGroups(entities({
                semantic: ['[protocol] WebSocket', '[database] Postgres'],
            }));
            assert.deepStrictEqual(groups.map(g => g.label), ['Databases', 'Protocols']);
            assert.deepStrictEqual(groups[0].items, ['Postgres']);
            assert.deepStrictEqual(groups[1].items, ['WebSocket']);
        });

        test('sorts regex and semantic groups together by label', () => {
            const groups = buildEntityTypeGroups(entities({
                filePaths: ['src/a.ts'],
                semantic: ['[tool] Docker', '[language] TypeScript'],
            }));
            assert.deepStrictEqual(groups.map(g => g.label), ['Files', 'Languages', 'Tools']);
        });

        test('drops semantic values that are empty after stripping the marker', () => {
            assert.deepStrictEqual(buildEntityTypeGroups(entities({ semantic: ['[tool]   '] })), []);
        });
    });
});

suite('SessionWebviewPanel – entities row markup', () => {
    const html = (SessionWebviewPanel as unknown as { _getShellHtml(): string })._getShellHtml();

    test('renders an entity-type dropdown and an entity-value dropdown', () => {
        assert.ok(html.includes('id="entity-type-select"'));
        assert.ok(html.includes('id="entity-value-select"'));
        assert.ok(!html.includes('cw-entity-chip'), 'chips should be replaced by dropdowns');
    });

    test('is an always-visible one-line row, not a collapsible section', () => {
        assert.ok(html.includes('<div id="session-entities"'));
        assert.ok(!html.includes('<details id="session-entities"'));
        assert.ok(!html.includes('cw-entities-summary'));

        const rowStart = html.indexOf('<div id="session-entities"');
        const rowEnd = html.indexOf('</div>', rowStart);
        const row = html.slice(rowStart, rowEnd);
        assert.ok(row.includes('class="cw-entity-label">Entities<'));
        assert.ok(row.indexOf('entity-type-select') < row.indexOf('entity-value-select'));
        assert.ok(!/id="session-entities"[^>]*display:\s*none/.test(html), 'row must always be visible');
    });

    test('styles the row as one compact line matching the surrounding text', () => {
        assert.ok(html.includes('#session-entities {'));
        assert.ok(html.includes('.cw-entity-label {'));
        assert.ok(html.includes('.cw-entity-select {'));
        assert.ok(html.includes('flex-wrap: nowrap'));
        assert.ok(html.includes('font-size: 1em;'));
        assert.ok(html.includes('height: 20px;'));
    });

    test('no longer hides the row while rendering', () => {
        assert.ok(!html.includes('entitiesEl.style.display'));
    });

    test('refreshes the value dropdown when the type dropdown changes', () => {
        assert.ok(html.includes("entTypeSel.addEventListener('change', populateEntityValues)"));
    });

    test('selecting an entity value seeds the search box and runs the search', () => {
        assert.ok(html.includes('function searchForEntity(value)'));
        assert.ok(html.includes('srchInput.value = value;'));
        assert.ok(html.includes('runSearch(value);'));
        assert.ok(html.includes("entValueSel.addEventListener('change'"));
    });

    test('populates both dropdowns from the host-provided entityGroups payload', () => {
        assert.ok(html.includes('renderEntityDropdowns(data.entityGroups || [])'));
    });

    test('shows a disabled empty state when a session has no entities', () => {
        assert.ok(html.includes("addPlaceholderOption(entTypeSel, 'No entities')"));
        assert.ok(html.includes('entTypeSel.disabled = true;'));
        assert.ok(html.includes('entValueSel.disabled = items.length === 0;'));
    });
});
