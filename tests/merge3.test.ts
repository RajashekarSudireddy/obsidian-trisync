import { describe, expect, it } from 'vitest';
import { merge3 } from '../src/sync/merge3';

describe('Myers O(ND) 3-way merge engine', () => {
  it('auto-merges disjoint top and bottom edits cleanly', () => {
    const base = 'line 1\nline 2\nline 3\nline 4\nline 5\n';
    const local = 'line 1 (Mac)\nline 2\nline 3\nline 4\nline 5\n';
    const remote = 'line 1\nline 2\nline 3\nline 4\nline 5 (iPhone)\n';

    const res = merge3(base, local, remote);
    expect(res.status).toBe('clean');
    expect(res.merged).toBe('line 1 (Mac)\nline 2\nline 3\nline 4\nline 5 (iPhone)\n');
  });

  it('deduplicates identical concurrent edits cleanly with no conflict', () => {
    const base = 'alpha\nbeta\ngamma\ndelta\n';
    const local = 'alpha\nBETA-UPDATED\ngamma\ndelta-mac\n';
    const remote = 'alpha\nBETA-UPDATED\ngamma\ndelta\n';

    const res = merge3(base, local, remote);
    expect(res.status).toBe('clean');
    expect(res.merged).toBe('alpha\nBETA-UPDATED\ngamma\ndelta-mac\n');

    // Exact whole-file identical edits even when base is null
    const identical = merge3(null, 'same text\n', 'same text\n');
    expect(identical.status).toBe('clean');
    expect(identical.merged).toBe('same text\n');
  });

  it('flags overlapping and adjacent line collisions as conflicts', () => {
    const base = 'line 1\nline 2\nline 3\n';

    // Same line overlap
    const overlap = merge3(
      base,
      'line 1\nline 2 local\nline 3\n',
      'line 1\nline 2 remote\nline 3\n'
    );
    expect(overlap.status).toBe('conflict');
    expect(overlap.reason).toBe('overlap');

    // Adjacent lines touching (line 1 vs line 2)
    const adjacent = merge3(
      base,
      'line 1 local\nline 2\nline 3\n',
      'line 1\nline 2 remote\nline 3\n'
    );
    expect(adjacent.status).toBe('conflict');
    expect(adjacent.reason).toBe('overlap');
  });

  it('merges insertions at BOF and EOF cleanly', () => {
    const base = 'body 1\nbody 2\nbody 3\n';
    const local = '--- frontmatter ---\nbody 1\nbody 2\nbody 3\n';
    const remote = 'body 1\nbody 2\nbody 3\n--- footer ---\n';

    const res = merge3(base, local, remote);
    expect(res.status).toBe('clean');
    expect(res.merged).toBe(
      '--- frontmatter ---\nbody 1\nbody 2\nbody 3\n--- footer ---\n'
    );
  });

  it('handles trailing newline mismatches losslessly', () => {
    const base = 'first\nmiddle\nlast';
    const local = 'first-edited\nmiddle\nlast';
    const remote = 'first\nmiddle\nlast\n';

    const res = merge3(base, local, remote);
    expect(res.status).toBe('clean');
    expect(res.merged).toBe('first-edited\nmiddle\nlast\n');
  });

  it('compares CRLF vs LF without false conflicts and preserves CRLF', () => {
    const base = 'row 1\r\nrow 2\r\nrow 3\r\nrow 4\r\n';
    const local = 'row 1 mac\r\nrow 2\r\nrow 3\r\nrow 4\r\n';
    const remote = 'row 1\nrow 2\nrow 3\nrow 4 android\n';

    const res = merge3(base, local, remote);
    expect(res.status).toBe('clean');
    expect(res.merged).toBe('row 1 mac\r\nrow 2\r\nrow 3\r\nrow 4 android\r\n');
  });

  it('returns missing-base conflict when base is null or undefined (never pretends base === "")', () => {
    const resNull = merge3(null, 'local v1\n', 'remote v2\n');
    expect(resNull.status).toBe('conflict');
    expect(resNull.reason).toBe('missing-base');

    const resUndef = merge3(undefined, 'local v1\n', 'remote v2\n');
    expect(resUndef.status).toBe('conflict');
    expect(resUndef.reason).toBe('missing-base');
  });

  it('enforces the 2 MB auto-merge cap', () => {
    const huge = 'a'.repeat(2 * 1024 * 1024 + 10);
    const res = merge3('base', huge, 'remote');
    expect(res.status).toBe('conflict');
    expect(res.reason).toBe('size-limit');
  });

  it('validates JSON post-merge for .canvas files and falls back to conflict if broken JSON', () => {
    // Valid .canvas merge (disjoint node properties)
    const baseCanvas = JSON.stringify(
      {
        nodes: [
          { id: 'n1', x: 0, y: 0, text: 'Node 1' },
          { id: 'n2', x: 100, y: 0, text: 'Node 2' },
        ],
        edges: [],
      },
      null,
      2
    );
    const localCanvas = baseCanvas.replace('"Node 1"', '"Node 1 edited"');
    const remoteCanvas = baseCanvas.replace('"Node 2"', '"Node 2 edited"');

    const cleanRes = merge3(baseCanvas, localCanvas, remoteCanvas, {
      path: 'Boards/Main.canvas',
    });
    expect(cleanRes.status).toBe('clean');
    expect(() => JSON.parse(cleanRes.merged!)).not.toThrow();
    const parsed = JSON.parse(cleanRes.merged!) as { nodes: Array<{ text: string }> };
    expect(parsed.nodes[0].text).toBe('Node 1 edited');
    expect(parsed.nodes[1].text).toBe('Node 2 edited');

    // Invalid JSON produced by text-level merge:
    // Local deletes an element leaving a trailing comma or mismatched braces
    const badBase = [
      '{',
      '  "a": 1,',
      '  "b": 2,',
      '  "c": 3,',
      '  "d": 4',
      '}',
    ].join('\n');
    // Local changes line `"d": 4` -> removes `"d"` (making `"c": 3,` dangling if untouched)
    const badLocal = [
      '{',
      '  "a": 1,',
      '  "b": 2,',
      '  "c": 3',
      '}',
    ].join('\n');
    // Remote edits `"a": 1` AND replaces `"d": 4` differently or adds a disjoint key after `"c": 3,`
    // Let's craft two valid JSON edits that text-merge into invalid JSON (dangling comma):
    const jsonBase = [
      '{',
      '  "nodes": [',
      '    {"id": "1"},',
      '    {"id": "2"},',
      '    {"id": "3"}',
      '  ],',
      '  "edges": [',
      '    {"id": "e1"}',
      '  ]',
      '}',
    ].join('\n');
    // Local deletes {"id": "3"} AND removes comma on {"id": "2"}
    const jsonLocal = [
      '{',
      '  "nodes": [',
      '    {"id": "1"},',
      '    {"id": "2"}',
      '  ],',
      '  "edges": [',
      '    {"id": "e1"}',
      '  ]',
      '}',
    ].join('\n');
    // Remote keeps {"id": "3"} and appends {"id": "4"} after {"id": "3"} —Wait: if local modified line 3-4 and remote modified line 4, they overlap.
    // To produce a CLEAN text merge that is INVALID JSON:
    // Base has `{\n  "k1": 1,\n  "k2": 2,\n  "k3": 3,\n  "k4": 4\n}` where local edits k1 to remove comma? No, both local & remote must be VALID JSON!
    // Valid JSON A & B that text-merge cleanly into INVALID JSON:
    // Base:
    // 0: {
    // 1:   "a": 1,
    // 2:   "b": 2,
    // 3:   "c": 3
    // 4: }
    // Wait: both are valid JSON:
    // Local removes `"c"` (edits lines 2-3 to `"b": 2` without comma -> hunk [2,4)).
    // Remote inserts `"d": 4` at EOF before `}` -> if base has a blank/comment-free structure:
    // Base:
    // 0: {
    // 1:   "nodes": [
    // 2:     {
    // 3:       "id": "1"
    // 4:     },
    // 5:     {
    // 6:       "id": "2"
    // 7:     }
    // 8:   ]
    // 9: }
    // Local adds a field inside node 1 (disjoint) — no, how does valid JSON + valid JSON text-merge to invalid JSON?
    // Local removes node 2 (lines 4-7: `}, { "id": "2" }` -> `}`): valid JSON!
    // Remote inserts node 3 AFTER line 7 (`},` + `{ "id": "3" }`) -> Wait, lines 7 is `}`!
    // Even simpler: Base has `"nodes": [\n  {"id":"1"}\n  ,\n  {"id":"2"}\n]`:
    // Local deletes `,\n  {"id":"2"}` (valid JSON: only node 1).
    // Remote deletes `{"id":"1"}\n  ,` (valid JSON: only node 2) -> if there's an unchanged line between them!
    // Base:
    // 0: [
    // 1:   {"id": "1"}
    // 2:   ,
    // 3:   {"id": "2"}
    // 4: ]
    // Wait: if line 2 is unchanged `,`, local deletes line 1 (`{"id": "1"}`)? Not valid JSON alone (`[, {"id":"2"}]` invalid).
    // What if base is `{"items": [1, 2, 3]}` formatted multi-line where local deletes `3` (editing line of `2,` -> `2`) and remote adds `4` after `3` (putting comma after `3`)?
    // Check base:
    // 0: [
    // 1:   {
    // 2:     "id": "a"
    // 3:   },
    // 4:   {
    // 5:     "id": "b"
    // 6:   }
    // 7: ]
    // Local changes line 3 `},` -> `}` AND deletes lines 4-6 -> hunk `[3, 7)`! Valid JSON (`[{"id":"a"}]`).
    // Remote keeps lines 1-3, changes line 6 `}` -> `},` AND inserts node c at line 7 -> hunk `[6, 7)` (touches 7!).
    // What if there's an unchanged line inside node b (lines 4-5 unchanged!)?
    // Base:
    // 0: [
    // 1:   1,
    // 2:   [
    // 3:     10
    // 4:   ]
    // 5: ]
    // Still touching? No! Look at a nested object where local deletes the closing `}`? Can't be valid JSON.
    // Think: what valid JSON + valid JSON produces invalid JSON on disjoint lines?
    // String multiline escaping? No, JSON doesn't allow raw newlines in strings.
    // YES!! Look at this classic valid JSON -> invalid JSON text merge:
    // Base:
    // 0: {
    // 1:   "a": [
    // 2:     1
    // 3:   ],
    // 4:   "b": 2
    // 5: }
    // Local changes `"a": [` (line 1) to `"a": 1, "x": [` (still valid: closes at line 3 `]`) -> hunk `[1, 2)`!
    // Remote changes `]` (line 3) to `], "y": 9` -> still valid.
    // What if Base is:
    // 0: {
    // 1:   "a": {
    // 2:     "inner": 1
    // 3:   }
    // 4: }
    // Local replaces lines 1..2? Wait:
    // Base:
    // 0: [
    // 1:   1,
    // 2:   2,
    // 3:   3,
    // 4:   4
    // 5: ]
    // Local turns `[1, 2, 3, 4]` into `[1, [2, 3], 4]` -> inserts `[` on line 1 (`1, [` hunk `[1,2)`) and `]` on line 3 (`3],` hunk `[3,4)`). Valid JSON!
    // Remote deletes line 3 (`3,` -> `""`? No, touches line 3).
    // Remote changes line 1 (`1,` -> `1,` unchanged) — Wait: Local turns `[1, 2, 3, 4]` into `[1, {"k": [2, 3]}, 4]` (edits line 1 and line 4), while Remote edits line 1 differently? No, disjoint!
    // OH! Even simpler:
    // Base:
    // 0: {
    // 1:   "first": 1,
    // 2:   "mid": 2,
    // 3:   "last": 3
    // 4: }
    // Local turns `"first": 1,` into `"first": [1,` (hunk `[1,2)`) AND `"last": 3` into `"last": 3]`? Not valid object.
    // Local wraps lines 2..3 in a nested array inside an array:
    // Base:
    // 0: [
    // 1:   0,
    // 2:   1,
    // 3:   2,
    // 4:   3,
    // 5:   4
    // 6: ]
    // Local inserts `[` after `0,` (hunk `[1,2)`) and `]` after `3,` (hunk `[4,5)`) -> `[0, [1, 2, 3], 4]` (VALID JSON! Lines 2, 3, 5 untouched!).
    // Remote inserts `[` after `1,` (hunk `[2,3)`) and `]` after `4` (hunk `[5,6)`) -> `[0, 1, [2, 3, 4]]` (VALID JSON!).
    // Wait: hunks `[1,2)` and `[2,3)` touch, so add one untouched line between them!
    // Base: `[0, 1, 2, 3, 4, 5, 6, 7]`!
    // Local wraps `[2..5]` -> edits line 1 (`0,` -> `0, [`) and line 5 (`4,` -> `4],`) -> VALID JSON!
    // Remote wraps `[4..7]` -> edits line 3 (`2,` -> `2, [`) and line 7 (`6` -> `6]`) -> VALID JSON!
    // Disjoint hunks: Local `[1,2)` & `[5,6)`, Remote `[3,4)` & `[7,8)`!
    // Clean text merge produces `[0, [1, 2, [3, 4], 5, 6]]` — WAIT that's balanced!
    // Make it cross-nested (`[` `(` `]` `)`): Local wraps `[2..5]` in `{ "x": [ ... ] }` (edits line 1 -> `0, {"x": [` and line 5 -> `4]},`) and Remote wraps `[4..7]` in `[ ... ]` (edits line 3 -> `2, [` and line 7 -> `6]`):
    // Text merge produces `[0, {"x": [1, 2, [3, 4]}, 5, 6]]` -> `]` closes `[` BEFORE `}`? NO, `}` tries to close `[` -> INVALID JSON!!
    const crossBase = '[\n  0,\n  1,\n  2,\n  3,\n  4,\n  5,\n  6\n]\n';
    const crossLocal = '[\n  0,\n  {"x": [\n  1,\n  2,\n  3,\n  4]},\n  5,\n  6\n]\n';
    const crossRemote = '[\n  0,\n  1,\n  2,\n  [\n  3,\n  4,\n  5,\n  6]\n]\n';
    expect(() => JSON.parse(crossBase)).not.toThrow();
    expect(() => JSON.parse(crossLocal)).not.toThrow();
    expect(() => JSON.parse(crossRemote)).not.toThrow();

    // Without JSON validation, text merge succeeds cleanly (producing cross-nested invalid JSON)
    const textOnly = merge3(crossBase, crossLocal, crossRemote, { validateJson: false });
    expect(textOnly.status).toBe('clean');
    expect(() => JSON.parse(textOnly.merged!)).toThrow();

    // With `.canvas` path (JSON validation enabled), merge3 catches the broken JSON and falls back to conflict!
    const canvasRes = merge3(crossBase, crossLocal, crossRemote, {
      path: 'Diagram.canvas',
    });
    expect(canvasRes.status).toBe('conflict');
    expect(canvasRes.reason).toBe('invalid-json');
  });

  it('merges 5,000-line files in < 20ms using Myers O(ND)', () => {
    const baseLines = Array.from({ length: 5000 }, (_, i) => `Line number ${i + 1} content`);
    const localLines = [...baseLines];
    const remoteLines = [...baseLines];

    localLines[10] = 'Local edit near top';
    localLines[250] = 'Another local edit';
    remoteLines[4800] = 'Remote edit near bottom';
    remoteLines.push('Appended remote footer');

    const base = baseLines.join('\n') + '\n';
    const local = localLines.join('\n') + '\n';
    const remote = remoteLines.join('\n') + '\n';

    const start = performance.now();
    const res = merge3(base, local, remote);
    const elapsedMs = performance.now() - start;

    expect(res.status).toBe('clean');
    expect(res.merged).toContain('Local edit near top');
    expect(res.merged).toContain('Remote edit near bottom');
    expect(res.merged).toContain('Appended remote footer');
    expect(elapsedMs).toBeLessThan(20);
  });
});
