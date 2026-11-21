import { describe, expect, it } from 'vitest';
import {
  IgnoreMatcher,
  buildCaseConflictPath,
  buildConflictPath,
  findInPathMap,
  foldPath,
  normalizePath,
  sanitizePathSegment,
} from '../src/sync/ignore';
import { DEFAULT_IGNORE_PATTERNS } from '../src/types';

describe('Ignore patterns, NFC normalization, case-folding & Android path safety', () => {
  it('ignores .obsidian/**, .trash/**, and default system junk', () => {
    const matcher = new IgnoreMatcher(DEFAULT_IGNORE_PATTERNS);

    expect(matcher.isIgnored('.obsidian')).toBe(true);
    expect(matcher.isIgnored('.obsidian/plugins/obsidian-trisync/data.json')).toBe(true);
    expect(matcher.isIgnored('.trash')).toBe(true);
    expect(matcher.isIgnored('.trash/Old Note.md')).toBe(true);
    expect(matcher.isIgnored('Notes/.DS_Store')).toBe(true);
    expect(matcher.isIgnored('Assets/Thumbs.db')).toBe(true);

    expect(matcher.isIgnored('Notes/Daily.md')).toBe(false);
    expect(matcher.isIgnored('obsidian-notes/guide.md')).toBe(false);
  });

  it('supports custom globs (**, *, ?)', () => {
    const matcher = new IgnoreMatcher([
      'private/**',
      '**/*.tmp',
      'draft-?.md',
      '# comment ignored',
    ]);

    expect(matcher.isIgnored('private/secret.md')).toBe(true);
    expect(matcher.isIgnored('private/deep/nested/file.pdf')).toBe(true);
    expect(matcher.isIgnored('notes/file.tmp')).toBe(true);
    expect(matcher.isIgnored('file.tmp')).toBe(true);
    expect(matcher.isIgnored('draft-1.md')).toBe(true);
    expect(matcher.isIgnored('draft-12.md')).toBe(false);
    expect(matcher.isIgnored('public/note.md')).toBe(false);
  });

  it('normalizes macOS NFD paths to NFC and strips redundant slashes', () => {
    const nfd = 'Projects/Cafe\u0301/Re\u0301sume\u0301.md';
    const nfc = 'Projects/Café/Résumé.md'.normalize('NFC');

    expect(normalizePath(nfd)).toBe(nfc);
    expect(normalizePath('\\Projects\\\\Café//Résumé.md/')).toBe(nfc);

    // Ignore matcher works across NFD vs NFC
    const matcher = new IgnoreMatcher(['Café/**'.normalize('NFC')]);
    expect(matcher.isIgnored('Cafe\u0301/note.md')).toBe(true);
  });

  it('supports case-folding lookup for APFS case-insensitive filesystems', () => {
    expect(foldPath('Notes/ReadMe.MD')).toBe('notes/readme.md');

    const map: Record<string, string> = {
      'Notes/ReadMe.md': 'id-1',
    };

    expect(findInPathMap(map, 'Notes/readme.md', false)).toBeNull();
    const found = findInPathMap(map, 'Notes/readme.md', true);
    expect(found).toEqual({ key: 'Notes/ReadMe.md', value: 'id-1' });
  });

  it('generates strictly Android-safe conflict filenames with ZERO forbidden characters', () => {
    const forbidden = /[:*?"<>|\\]/;
    const fixedDate = new Date('2026-11-19T14:33:01Z');

    // Device name containing forbidden Android/Windows chars
    const conflictPath = buildConflictPath(
      'Notes/Daily:Plan?.md',
      'Raj:iPhone*Pro/Max\\<15>',
      fixedDate
    );

    const fileName = conflictPath.split('/').pop()!;
    expect(fileName).not.toMatch(forbidden);
    expect(fileName).not.toContain('/');
    expect(fileName).toContain('2026-11-19 143301');
    expect(fileName).not.toContain(':');
    expect(conflictPath.startsWith('Notes/')).toBe(true);
    expect(conflictPath.endsWith('.md')).toBe(true);

    // Direct segment sanitizer check
    expect(sanitizePathSegment('a:b*c?d"e<f>g|h\\i/j')).not.toMatch(/[:*?"<>|\\/]/);
  });

  it('builds deterministic case-conflict disambiguation paths', () => {
    const disambiguated = buildCaseConflictPath('Docs/README.md', 'drive_abc123456');
    expect(disambiguated).toBe('Docs/README (case-conflict drive_).md');
  });
});
