import { isJsonPath } from './ignore';

/**
 * Myers O(ND) line diff and 3-way merge engine.
 * - CRLF-safe line comparison while preserving line endings.
 * - Identical concurrent hunk deduplication (clean merge, zero false conflicts).
 * - Adjacent/overlapping line collisions safely flagged as conflicts.
 * - 2 MB auto-merge safety cap.
 * - `.canvas` / `.json` post-merge `JSON.parse()` validation fallback.
 * - Missing-base safety fallback (never pretends base === "" when base was lost).
 */

export const MAX_AUTO_MERGE_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_MYERS_D = 4000;

export type MergeConflictReason =
  | 'overlap'
  | 'missing-base'
  | 'size-limit'
  | 'invalid-json'
  | 'diff-limit';

export interface Merge3Result {
  status: 'clean' | 'conflict';
  merged?: string;
  reason?: MergeConflictReason;
}

export interface Merge3Options {
  path?: string;
  validateJson?: boolean;
  maxBytes?: number;
}

export interface DiffHunk {
  baseStart: number;
  baseEnd: number;
  replacement: string[];
}

const utf8Encoder = new TextEncoder();

function splitLinesPreserveTerminator(text: string): string[] {
  if (text.length === 0) return [];
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) {
    lines.push(text.slice(start));
  }
  return lines;
}

function normalizeCrlf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function hasCrlf(text: string): boolean {
  return text.includes('\r\n');
}

function toCrlf(text: string): string {
  return text.replace(/\n/g, '\r\n');
}

/**
 * Computes Myers O(ND) edit hunks transforming `a` into `b`.
 * Returns `null` if the edit distance exceeds `MAX_MYERS_D`.
 */
export function myersDiffHunks(a: readonly string[], b: readonly string[]): DiffHunk[] | null {
  const nTotal = a.length;
  const mTotal = b.length;

  // Strip common prefix and suffix for O(1)-ish speed on large files with localized edits
  let prefix = 0;
  const minLen = Math.min(nTotal, mTotal);
  while (prefix < minLen && a[prefix] === b[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    a[nTotal - 1 - suffix] === b[mTotal - 1 - suffix]
  ) {
    suffix++;
  }

  const aMid = a.slice(prefix, nTotal - suffix);
  const bMid = b.slice(prefix, mTotal - suffix);
  const n = aMid.length;
  const m = bMid.length;

  if (n === 0 && m === 0) {
    return [];
  }
  if (n === 0) {
    return [{ baseStart: prefix, baseEnd: prefix, replacement: [...bMid] }];
  }
  if (m === 0) {
    return [{ baseStart: prefix, baseEnd: prefix + n, replacement: [] }];
  }

  const maxD = Math.min(n + m, MAX_MYERS_D);
  const offset = maxD;
  const v = new Int32Array(2 * maxD + 1);
  const trace: Int32Array[] = [];

  let foundD = -1;
  for (let d = 0; d <= maxD; d++) {
    // Store [-d..d] snapshot of step d-1 before step d mutates v
    const snapshot = new Int32Array(2 * d + 1);
    for (let k = -d; k <= d; k++) {
      snapshot[k + d] = v[k + offset];
    }
    trace.push(snapshot);

    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
        x = v[k + 1 + offset];
      } else {
        x = v[k - 1 + offset] + 1;
      }
      let y = x - k;
      while (x < n && y < m && aMid[x] === bMid[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) {
        foundD = d;
        break;
      }
    }
    if (foundD !== -1) break;
  }

  if (foundD === -1) {
    return null;
  }

  // Backtrack edit operations in reverse
  // Op: 0 = equal, 1 = delete from a, 2 = insert from b
  const ops: Array<{ kind: 0 | 1 | 2; ax: number; by: number }> = [];
  let x = n;
  let y = m;

  for (let d = foundD; d > 0; d--) {
    const prevSnap = trace[d]; // snapshot captured BEFORE step d ran -> holds step d-1 values
    const k = x - y;
    let prevK: number;

    const getPrev = (diag: number): number => {
      if (diag < -(d - 1) || diag > d - 1) return -1;
      return prevSnap[diag + d];
    };

    if (k === -d || (k !== d && getPrev(k - 1) < getPrev(k + 1))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }

    const prevX = getPrev(prevK);
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ kind: 0, ax: x, by: y });
    }

    if (x === prevX) {
      // Insertion from b
      y--;
      ops.push({ kind: 2, ax: x, by: y });
    } else {
      // Deletion from a
      x--;
      ops.push({ kind: 1, ax: x, by: y });
    }
  }

  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ kind: 0, ax: x, by: y });
  }

  ops.reverse();

  // Group contiguous non-equal ops into DiffHunks
  const hunks: DiffHunk[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].kind === 0) {
      i++;
      continue;
    }
    const baseStart = prefix + ops[i].ax;
    let baseEnd = baseStart;
    const replacement: string[] = [];

    while (i < ops.length && ops[i].kind !== 0) {
      if (ops[i].kind === 1) {
        baseEnd = prefix + ops[i].ax + 1;
      } else {
        replacement.push(bMid[ops[i].by]);
      }
      i++;
    }
    hunks.push({ baseStart, baseEnd, replacement });
  }

  return hunks;
}

function applyHunksToRange(
  base: readonly string[],
  rangeStart: number,
  rangeEnd: number,
  hunks: readonly DiffHunk[]
): string[] {
  const out: string[] = [];
  let cursor = rangeStart;
  for (const h of hunks) {
    if (h.baseStart > cursor) {
      for (let i = cursor; i < h.baseStart; i++) {
        out.push(base[i]);
      }
    }
    for (const line of h.replacement) {
      out.push(line);
    }
    cursor = h.baseEnd;
  }
  if (cursor < rangeEnd) {
    for (let i = cursor; i < rangeEnd; i++) {
      out.push(base[i]);
    }
  }
  return out;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Performs a deterministic 3-way line merge between `base`, `local`, and `remote`.
 */
export function merge3(
  base: string | null | undefined,
  local: string,
  remote: string,
  options: Merge3Options = {}
): Merge3Result {
  const maxBytes = options.maxBytes ?? MAX_AUTO_MERGE_BYTES;

  // Identical concurrent edits always resolve cleanly without needing base
  const localNorm = normalizeCrlf(local);
  const remoteNorm = normalizeCrlf(remote);
  if (localNorm === remoteNorm) {
    const out = hasCrlf(local) ? toCrlf(localNorm) : localNorm;
    return finalizeResult(out, options);
  }

  // Missing base safety fallback: NEVER pretend base === "" when base snapshot is lost
  if (base === null || base === undefined) {
    return { status: 'conflict', reason: 'missing-base' };
  }

  // Enforce 2 MB size cap
  if (
    utf8Encoder.encode(base).byteLength > maxBytes ||
    utf8Encoder.encode(local).byteLength > maxBytes ||
    utf8Encoder.encode(remote).byteLength > maxBytes
  ) {
    return { status: 'conflict', reason: 'size-limit' };
  }

  const baseNorm = normalizeCrlf(base);
  const preserveCrlf = hasCrlf(local) || (hasCrlf(base) && hasCrlf(remote));

  if (localNorm === baseNorm) {
    const out = preserveCrlf ? toCrlf(remoteNorm) : remoteNorm;
    return finalizeResult(out, options);
  }
  if (remoteNorm === baseNorm) {
    const out = preserveCrlf ? toCrlf(localNorm) : localNorm;
    return finalizeResult(out, options);
  }

  const baseLines = splitLinesPreserveTerminator(baseNorm);
  const localLines = splitLinesPreserveTerminator(localNorm);
  const remoteLines = splitLinesPreserveTerminator(remoteNorm);

  const localHunks = myersDiffHunks(baseLines, localLines);
  const remoteHunks = myersDiffHunks(baseLines, remoteLines);

  if (localHunks === null || remoteHunks === null) {
    return { status: 'conflict', reason: 'diff-limit' };
  }

  // Merge sorted hunks from both sides into non-interacting spans.
  // Hunks from opposite sides interact if they overlap OR touch (adjacent lines).
  const outLines: string[] = [];
  let baseCursor = 0;
  let li = 0;
  let ri = 0;

  while (li < localHunks.length || ri < remoteHunks.length) {
    const nextL = li < localHunks.length ? localHunks[li] : null;
    const nextR = ri < remoteHunks.length ? remoteHunks[ri] : null;

    if (nextL && (!nextR || nextL.baseEnd < nextR.baseStart)) {
      // Strictly disjoint local-only hunk
      for (let i = baseCursor; i < nextL.baseStart; i++) {
        outLines.push(baseLines[i]);
      }
      for (const line of nextL.replacement) {
        outLines.push(line);
      }
      baseCursor = nextL.baseEnd;
      li++;
      continue;
    }

    if (nextR && (!nextL || nextR.baseEnd < nextL.baseStart)) {
      // Strictly disjoint remote-only hunk
      for (let i = baseCursor; i < nextR.baseStart; i++) {
        outLines.push(baseLines[i]);
      }
      for (const line of nextR.replacement) {
        outLines.push(line);
      }
      baseCursor = nextR.baseEnd;
      ri++;
      continue;
    }

    // Overlapping or adjacent cluster: greedily expand cluster span [spanStart, spanEnd]
    // to include all hunks from either side that overlap or touch the cluster.
    const clusterLocal: DiffHunk[] = [];
    const clusterRemote: DiffHunk[] = [];

    let spanStart = Math.min(nextL!.baseStart, nextR!.baseStart);
    let spanEnd = Math.max(nextL!.baseEnd, nextR!.baseEnd);
    clusterLocal.push(localHunks[li++]);
    clusterRemote.push(remoteHunks[ri++]);

    let expanded = true;
    while (expanded) {
      expanded = false;
      while (li < localHunks.length && localHunks[li].baseStart <= spanEnd) {
        const h = localHunks[li++];
        clusterLocal.push(h);
        if (h.baseEnd > spanEnd) spanEnd = h.baseEnd;
        expanded = true;
      }
      while (ri < remoteHunks.length && remoteHunks[ri].baseStart <= spanEnd) {
        const h = remoteHunks[ri++];
        clusterRemote.push(h);
        if (h.baseEnd > spanEnd) spanEnd = h.baseEnd;
        expanded = true;
      }
    }

    const localSlice = applyHunksToRange(baseLines, spanStart, spanEnd, clusterLocal);
    const remoteSlice = applyHunksToRange(baseLines, spanStart, spanEnd, clusterRemote);

    if (!arraysEqual(localSlice, remoteSlice)) {
      return { status: 'conflict', reason: 'overlap' };
    }

    // Identical concurrent edits over the span — resolve cleanly!
    for (let i = baseCursor; i < spanStart; i++) {
      outLines.push(baseLines[i]);
    }
    for (const line of localSlice) {
      outLines.push(line);
    }
    baseCursor = spanEnd;
  }

  for (let i = baseCursor; i < baseLines.length; i++) {
    outLines.push(baseLines[i]);
  }

  let mergedText = outLines.join('');
  if (preserveCrlf) {
    mergedText = toCrlf(mergedText);
  }

  return finalizeResult(mergedText, options);
}

function finalizeResult(merged: string, options: Merge3Options): Merge3Result {
  const shouldValidateJson =
    options.validateJson ?? (options.path ? isJsonPath(options.path) : false);
  if (shouldValidateJson) {
    try {
      JSON.parse(merged);
    } catch {
      return { status: 'conflict', reason: 'invalid-json' };
    }
  }
  return { status: 'clean', merged };
}
