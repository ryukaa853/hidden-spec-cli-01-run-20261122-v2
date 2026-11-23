// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format.
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON
// edits), finds the lines each edit names at the first of three matching tiers, and writes
// every change or none, printing what it changed or why it failed. Node 22, the standard
// library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this
// file hands over to runner.ts (the last lines below): keep that hand-over and runner.ts
// as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer: the one line it prints. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines (SPEC.md section 3): split at `\n`, one trailing `\r` off each line, and
 * no empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A safe path (SPEC.md section 3): not empty, not absolute, no backslash, and no segment
 * empty, `.` or `..`. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read
 * from disk. A path that exists on disk as a directory is not a file, but it does exist,
 * so a create or a move onto it is an `exists` failure rather than a write that cannot
 * happen. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful move edit made, in patch order, for the `R` output lines. */
  readonly moves: { old: string; new: string }[] = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  /** True when `p` exists on disk as a directory. */
  isDir(p: string): boolean {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  }

  /** True when the path `p` exists in the tree the patch is building: as a file, as a
   * directory on disk, or as the parent directory of a file the tree will hold. Used for
   * the `exists` failure of creates and move targets. */
  pathExists(p: string): boolean {
    if (this.get(p) !== null) return true;
    if (this.isDir(p)) return true;
    const prefix = `${p}/`;
    for (const q of this.now.keys()) {
      if (q.startsWith(prefix) && this.get(q) !== null) return true;
    }
    return false;
  }
}

type Edit = (tree: Tree) => void;

/** The format a patch is in (SPEC.md section 4), or null when none of the four holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One edit step inside a hunk or chunk: a context line, a removed line, or an added line. */
interface Op {
  kind: 'ctx' | 'del' | 'add';
  text: string;
}

function opFromBodyLine(line: string): Op {
  if (line.startsWith(' ')) return { kind: 'ctx', text: line.slice(1) };
  if (line.startsWith('-')) return { kind: 'del', text: line.slice(1) };
  if (line.startsWith('+')) return { kind: 'add', text: line.slice(1) };
  return { kind: 'ctx', text: '' };
}

/** A file split the way SPEC.md section 3 says: one line break for the whole file. */
interface SplitFile {
  br: string;
  lines: string[];
  ends: boolean;
}

function splitFile(text: string): SplitFile {
  if (text === '') return { br: '\n', lines: [], ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const ends = text.endsWith(br);
  if (ends) lines.pop();
  return { br, lines, ends };
}

function joinFile(f: SplitFile): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.ends ? f.br : '');
}

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const trimTrailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** Whether two lines are equal at one matching tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrailWs(a) === trimTrailWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

/** Every 0-based position where `oldLines` occur in `fileLines` at one tier, at or after
 * `from`. Occurrences may overlap. */
function occurrencesAt(fileLines: string[], oldLines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (oldLines.length === 0) return out;
  for (let i = Math.max(0, from); i + oldLines.length <= fileLines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j += 1) {
      if (!lineEq(fileLines[i + j]!, oldLines[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which `oldLines` occur, with
 * every occurrence at that tier. */
function findMatch(fileLines: string[], oldLines: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = occurrencesAt(fileLines, oldLines, tier, from);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** The first line at or after `from` equal to `line` at the first tier where one is. */
function findSingleLine(fileLines: string[], line: string, strict: boolean, from: number): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = Math.max(0, from); i < fileLines.length; i += 1) {
      if (lineEq(fileLines[i]!, line, tier)) return i;
    }
  }
  return -1;
}

/**
 * The new lines an op list writes over a match at `pos`: context lines come from the file
 * itself, added lines are re-indented only at tier 2 (SPEC.md section 5): let F be the
 * leading spaces and tabs of the file's first matched line and P those of O's first line;
 * a line of N that is not empty and not only whitespace, and starts with P, has that P
 * replaced by F; any other line is written as it is.
 */
function renderOps(ops: Op[], fileLines: string[], pos: number, tier: number): string[] {
  const old = ops.filter((o) => o.kind !== 'add').map((o) => o.text);
  let p = '';
  let f = '';
  if (tier === 2 && old.length > 0) {
    p = leadWs(old[0]!);
    f = leadWs(fileLines[pos] ?? '');
  }
  const out: string[] = [];
  let oi = 0;
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (op.kind === 'del') {
      oi += 1;
    } else if (tier === 2 && op.text !== '' && op.text.trim() !== '' && op.text.startsWith(p)) {
      out.push(f + op.text.slice(p.length));
    } else {
      out.push(op.text);
    }
  }
  return out;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.pathExists(p)) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

/** The edits a JSON patch holds (SPEC.md section 9): one JSON array of edit objects, or
 * JSON Lines with one edit object a line. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One unified hunk (SPEC.md section 6): its old-side start line and its body steps. */
interface UniHunk {
  a: number;
  ops: Op[];
  /** True when a `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** The hunk's body lines as read, `\` lines included, for creation files. */
  raw: string[];
}

interface UniSection {
  diffA: string | null;
  diffB: string | null;
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UniHunk[];
}

/** The path a `---`/`+++` line names: up to the first tab, trimmed, `/dev/null` for none,
 * with a leading `a/` or `b/` removed from either. */
function gitPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** A hunk header: `@@ -A[,B] +C[,D] @@`, optionally followed by text. The text may follow
 * the closing `@@` at once; B and D are not used. */
const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Apply a section's hunks in order to a split file; hunks after the first see the
 * earlier ones. */
function applyHunks(start: SplitFile, hunks: UniHunk[], strict: boolean, path: string): SplitFile {
  const lines = [...start.lines];
  let ends = start.ends;
  let d = 0;
  for (const hunk of hunks) {
    const old = hunk.ops.filter((o) => o.kind !== 'add').map((o) => o.text);
    if (old.length === 0) {
      let at = hunk.a + d;
      if (at < 0) at = 0;
      if (at > lines.length) at = lines.length;
      const ins = renderOps(hunk.ops, lines, at, 0);
      const atEnd = at === lines.length;
      lines.splice(at, 0, ...ins);
      if (atEnd) ends = !hunk.noEol;
      d += ins.length;
      continue;
    }
    const m = findMatch(lines, old, strict, 0);
    if (m === null) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let pos = m.occ[0]!;
    for (const cand of m.occ) {
      if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
    }
    const rep = renderOps(hunk.ops, lines, pos, m.tier);
    const atEnd = pos + old.length === lines.length;
    lines.splice(pos, old.length, ...rep);
    if (atEnd) ends = !hunk.noEol;
    d += rep.length - old.length;
  }
  return { br: start.br, lines, ends };
}

/** The edits a unified diff holds (SPEC.md section 6). */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { diffA: m[1]!, diffB: m[2]!, oldPath: null, newPath: null, renameFrom: null, renameTo: null, isCreate: false, isDelete: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !inHeader) {
        cur = { diffA: null, diffB: null, oldPath: null, newPath: null, renameFrom: null, renameTo: null, isCreate: false, isDelete: false, hunks: [] };
        sections.push(cur);
        inHeader = true;
      }
      cur.oldPath = gitPath(l.slice(4));
      cur.newPath = gitPath(lines[i + 1]!.slice(4));
      i += 2;
      continue;
    }
    if (cur !== null && inHeader && l.startsWith('--- ')) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith('@@')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          body.push(b);
          i += 1;
          continue;
        }
        break;
      }
      // Empty lines at the end of a body are not part of it. "Empty" here is zero-length:
      // a ` ` line is a context line whose text is empty, and it stays in the body.
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      let noEol = false;
      if (body.length >= 2 && body[body.length - 1]!.startsWith('\\')) {
        const prev = body[body.length - 2]!;
        noEol = prev.startsWith(' ') || prev.startsWith('+');
      }
      cur.hunks.push({ a: Number(m[1]), ops: body.filter((b) => !b.startsWith('\\')).map(opFromBodyLine), noEol, raw: body });
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice(12).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice(10).trim();
      else if (l.startsWith('new file mode')) cur.isCreate = true;
      else if (l.startsWith('deleted file mode')) cur.isDelete = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((sec) => {
    const oldP = sec.oldPath ?? sec.renameFrom ?? sec.diffA;
    const newP = sec.newPath ?? sec.renameTo ?? sec.diffB;
    const create = sec.isCreate || oldP === null;
    const del = !create && (sec.isDelete || newP === null);
    if (create) {
      return (tree: Tree): void => {
        const np = newP ?? '';
        if (!safe(np)) throw new Fail('unsafe', np);
        if (tree.pathExists(np)) throw new Fail('exists', np);
        const plus: string[] = [];
        let noEol = false;
        for (const hunk of sec.hunks) {
          for (let j = 0; j < hunk.raw.length; j += 1) {
            if (hunk.raw[j]!.startsWith('+')) {
              plus.push(hunk.raw[j]!.slice(1));
              noEol = j + 1 < hunk.raw.length && hunk.raw[j + 1]!.startsWith('\\');
            }
          }
        }
        tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      };
    }
    if (del) {
      return (tree: Tree): void => {
        const op = oldP ?? '';
        if (!safe(op)) throw new Fail('unsafe', op);
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
      };
    }
    if (oldP !== newP) {
      return (tree: Tree): void => {
        const op = oldP ?? '';
        const np = newP ?? '';
        if (!safe(op)) throw new Fail('unsafe', op);
        if (!safe(np)) throw new Fail('unsafe', np);
        const curText = tree.get(op);
        if (curText === null) throw new Fail('missing', op);
        if (tree.pathExists(np)) throw new Fail('exists', np);
        const out = applyHunks(splitFile(curText), sec.hunks, strict, op);
        tree.now.set(op, null);
        tree.now.set(np, joinFile(out));
        tree.moves.push({ old: op, new: np });
      };
    }
    return (tree: Tree): void => {
      const op = oldP ?? '';
      if (!safe(op)) throw new Fail('unsafe', op);
      const curText = tree.get(op);
      if (curText === null) throw new Fail('missing', op);
      tree.now.set(op, joinFile(applyHunks(splitFile(curText), sec.hunks, strict, op)));
    };
  });
}

/** The edits SEARCH/REPLACE blocks hold (SPEC.md section 7). */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j += 1;
    if (j >= lines.length) throw new Exit2(`error: parse ${searchLine + 1}`);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k += 1;
    if (k >= lines.length) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(i + 1, j);
    const newLines = lines.slice(j + 1, k);
    let path: string | null = null;
    for (let p = searchLine - 1; p > prevEnd; p -= 1) {
      const t = lines[p]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    prevPath = path;
    prevEnd = k;
    const ops: Op[] = [...oldLines.map((t) => ({ kind: 'del' as const, text: t })), ...newLines.map((t) => ({ kind: 'add' as const, text: t }))];
    edits.push(((p, oldLs, opsLs) => (tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLs.length === 0) {
        if (tree.pathExists(p)) throw new Fail('exists', p);
        tree.now.set(p, opsLs.length === 0 ? '' : opsLs.map((o) => o.text).join('\n') + '\n');
        return;
      }
      const curText = tree.get(p);
      if (curText === null) throw new Fail('missing', p);
      const info = splitFile(curText);
      const m = findMatch(info.lines, oldLs, strict, 0);
      if (m === null) throw new Fail('no-match', p);
      if (m.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = m.occ[0]!;
      const rep = renderOps(opsLs, info.lines, pos, m.tier);
      const out = [...info.lines];
      out.splice(pos, oldLs.length, ...rep);
      tree.now.set(p, joinFile({ br: info.br, lines: out, ends: info.ends }));
    })(path, oldLines, ops));
    i = k + 1;
  }
  return edits;
}

/** One V4A chunk: an optional anchor line, whether it is end-of-file, and its body steps. */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  ops: Op[];
}

/** Which kind of V4A section a line starts, or null when it starts none. */
function v4aSectionKind(l: string): 'add' | 'delete' | 'update' | null {
  if (l.startsWith('*** Add File: ')) return 'add';
  if (l.startsWith('*** Delete File: ')) return 'delete';
  if (l.startsWith('*** Update File: ')) return 'update';
  return null;
}

/** The edits a V4A patch holds (SPEC.md section 8).
 *
 * Blank lines at the end of a section (before the next section or `*** End Patch`) are
 * not part of it, so each section's lines are set aside first and the section is read
 * from what is left: a blank line inside a section — at the end of a chunk, before the
 * next `@@` or before `*** End of File` — stays a body line of that chunk. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const kind = v4aSectionKind(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const headLine = i + 1;
    const path = l.slice(kind === 'add' ? '*** Add File: '.length : kind === 'delete' ? '*** Delete File: '.length : '*** Update File: '.length).trim();
    // The section's lines run to the next section start or to `*** End Patch`; blank
    // lines at the end of that run are not part of the section.
    let end = i + 1;
    while (end < last && v4aSectionKind(lines[end]!) === null) end += 1;
    let bodyEnd = end;
    while (bodyEnd > i + 1 && blank(lines[bodyEnd - 1]!)) bodyEnd -= 1;
    if (kind === 'add') {
      const flines: string[] = [];
      for (let j = i + 1; j < bodyEnd; j += 1) {
        const b = lines[j]!;
        if (b.startsWith('+')) flines.push(b.slice(1));
        else if (b === '') flines.push('');
        else throw new Exit2(`error: parse ${j + 1}`);
      }
      edits.push(((p, fs) => (tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.pathExists(p)) throw new Fail('exists', p);
        tree.now.set(p, fs.length === 0 ? '' : fs.join('\n') + '\n');
      })(path, flines));
      i = end;
      continue;
    }
    if (kind === 'delete') {
      if (bodyEnd > i + 1) throw new Exit2(`error: parse ${i + 2}`);
      edits.push(((p) => (tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      })(path));
      i = end;
      continue;
    }
    // Update File: an optional `*** Move to:` first line, then chunks.
    let moveTo: string | null = null;
    const chunks: VChunk[] = [];
    let curChunk: VChunk | null = null;
    const closeChunk = (): void => {
      if (curChunk !== null) {
        chunks.push(curChunk);
        curChunk = null;
      }
    };
    let j = i + 1;
    while (j < bodyEnd) {
      const b = lines[j]!;
      if (j === i + 1 && b.startsWith('*** Move to: ')) {
        moveTo = b.slice('*** Move to: '.length).trim();
        j += 1;
        continue;
      }
      if (b.startsWith('@@')) {
        closeChunk();
        const anchor = b.slice(2).trim();
        curChunk = { anchor: anchor === '' ? null : anchor, eof: false, ops: [] };
        j += 1;
        continue;
      }
      if (b === '*** End of File') {
        if (curChunk === null) throw new Exit2(`error: parse ${j + 1}`);
        curChunk.eof = true;
        closeChunk();
        j += 1;
        continue;
      }
      if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+') {
        if (curChunk === null) curChunk = { anchor: null, eof: false, ops: [] };
        curChunk.ops.push(opFromBodyLine(b));
        j += 1;
        continue;
      }
      throw new Exit2(`error: parse ${j + 1}`);
    }
    closeChunk();
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headLine}`);
    edits.push(((p, mv, chs) => (tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (mv !== null && !safe(mv)) throw new Fail('unsafe', mv);
      const curText = tree.get(p);
      if (curText === null) throw new Fail('missing', p);
      if (mv !== null && tree.pathExists(mv)) throw new Fail('exists', mv);
      const info = splitFile(curText);
      const outLines = [...info.lines];
      let cursor = 0;
      for (const ch of chs) {
        if (ch.anchor !== null) {
          const at = findSingleLine(outLines, ch.anchor, strict, cursor);
          if (at < 0) throw new Fail('no-match', p);
          cursor = at + 1;
        }
        const old = ch.ops.filter((o) => o.kind !== 'add').map((o) => o.text);
        if (old.length === 0) {
          const at = ch.eof ? outLines.length : cursor;
          const ins = renderOps(ch.ops, outLines, at, 0);
          outLines.splice(at, 0, ...ins);
          cursor = at + ins.length;
          continue;
        }
        const tiers = strict ? [0] : [0, 1, 2];
        let found: { tier: number; occ: number[] } | null = null;
        for (const tier of tiers) {
          const occ = occurrencesAt(outLines, old, tier, cursor).filter((pos) => !ch.eof || pos + old.length === outLines.length);
          if (occ.length > 0) {
            found = { tier, occ };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', p);
        const pos = found.occ[0]!;
        const rep = renderOps(ch.ops, outLines, pos, found.tier);
        outLines.splice(pos, old.length, ...rep);
        cursor = pos + rep.length;
      }
      const out = joinFile({ br: info.br, lines: outLines, ends: info.ends });
      if (mv !== null) {
        tree.now.set(p, null);
        tree.now.set(mv, out);
        tree.moves.push({ old: p, new: mv });
      } else {
        tree.now.set(p, out);
      }
    })(path, moveTo, chunks));
    i = end;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  for (const mv of tree.moves) {
    const wasOld = tree.original(mv.old);
    const wasNew = tree.original(mv.new);
    const nowOld = tree.now.get(mv.old);
    const nowNew = tree.now.get(mv.new);
    if (wasOld !== null && wasNew === null && nowOld === null && nowNew !== null) {
      const dAt = rows.findIndex((r) => r.line === `D ${mv.old}`);
      const aAt = rows.findIndex((r) => r.line === `A ${mv.new}`);
      if (dAt >= 0 && aAt >= 0) {
        rows.splice(Math.max(dAt, aAt), 1);
        rows.splice(Math.min(dAt, aAt), 1);
        rows.push({ key: mv.new, line: `R ${mv.old} -> ${mv.new}` });
      }
    }
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
