/**
 * Rule 7 (design §3.3): a best-effort check that blocks a `bash` command which
 * plainly writes to a protected path. It is a signal, not a boundary: an
 * interpreter one-liner (`python3 -c "open('AGENTS.md','w')"`), a variable or a
 * command substitution naming the path, `find -delete`, or a patch whose
 * targets are inside the patch file all get past it. The boundary for protected
 * files is the host-side diff gate (design §3.1), and the next node's
 * session_start checks catch a planted Pi dir or worktree.
 *
 * The command is split into simple commands (on `;`, `&`, `&&`, `|`, `||`,
 * newlines and parentheses) with shell quoting, `#` comments and heredoc bodies
 * handled. A simple command blocks when a word resolves (after `cd`s earlier in
 * the command, `~`, symlinks and a shell glob's expansion) to a protected path
 * of the worktree, or into Pi's agent dir or the guard's ledger, and the
 * command has a write indicator:
 *
 * - an output redirection (`>`, `>>`, `>|`, `&>`, `N>`): only its target counts;
 * - a file command anywhere in it (`tee`, `rm`, `mv`, `cp`, `ln`, `chmod`,
 *   `chown`, `truncate`, `dd`, `install`, `touch`, `mkdir`, `rmdir`, `unlink`,
 *   `patch`, also after `sudo`, `env`, `xargs` or a path): every word counts,
 *   and the value after `=` (`of=`, `--directory=`);
 * - an in-place edit (`sed -i`/`--in-place`, `perl -i`);
 * - git's `config` (not `--get`/`--list`; it writes `.git/config`), `apply`,
 *   `checkout`, `restore`, `rm` and `mv`.
 *
 * `rm`, `rmdir`, `mv`, `git rm` and `git mv` on a directory also count every
 * file under it (breadth first, up to WALK_LIMIT entries, after which the rest
 * is unchecked), so `rm -rf .` blocks on the root's AGENTS.md or .git.
 */
import { lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isProtected, realPath, relTo, type Roots, within } from "./paths";

/** One simple command: its words, and the targets of its output redirections. */
export interface Segment {
  words: string[];
  redirects: string[];
}

/** Skip the bodies of the heredocs opened on the line that ends at `i`; returns the index after the last closing line. */
function skipHeredocs(command: string, i: number, delimiters: string[]): number {
  let at = i;
  for (const d of delimiters) {
    for (;;) {
      if (at >= command.length) return at;
      const nl = command.indexOf("\n", at);
      const line = command.slice(at, nl < 0 ? command.length : nl);
      at = nl < 0 ? command.length : nl + 1;
      if (line.replace(/^\t+/, "") === d) break;
    }
  }
  return at;
}

/** Split a bash command into simple commands, best effort: quoting and escapes as bash reads them, no expansion. */
export function parseShell(command: string): Segment[] {
  const segments: Segment[] = [];
  let seg: Segment = { words: [], redirects: [] };
  let word: string | null = null;
  let redirect = false;
  let dup = false;
  let heredocNext = false;
  let heredocs: string[] = [];
  const endWord = () => {
    if (word === null) return;
    if (redirect) {
      // `>&1` and `>&-` duplicate or close a descriptor: no file.
      if (!(dup && /^(\d+|-)$/.test(word))) seg.redirects.push(word);
      redirect = false;
      dup = false;
    } else if (heredocNext) {
      heredocs.push(word);
      heredocNext = false;
    } else seg.words.push(word);
    word = null;
  };
  const endSeg = () => {
    endWord();
    if (seg.words.length > 0 || seg.redirects.length > 0) segments.push(seg);
    seg = { words: [], redirects: [] };
  };
  /** A word of digits right before `>` or `<` is a descriptor number, not a word. */
  const fdOrEnd = () => {
    if (word !== null && /^\d+$/.test(word)) word = null;
    else endWord();
  };
  let i = 0;
  while (i < command.length) {
    const c = command[i]!;
    if (c === "\\") {
      if (command[i + 1] !== "\n") word = (word ?? "") + (command[i + 1] ?? "");
      i += 2;
    } else if (c === "'") {
      const j = command.indexOf("'", i + 1);
      const end = j < 0 ? command.length : j;
      word = (word ?? "") + command.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < command.length && command[j] !== '"') {
        if (command[j] === "\\" && j + 1 < command.length && '"\\$`\n'.includes(command[j + 1]!)) {
          s += command[j + 1];
          j += 2;
        } else s += command[j++];
      }
      word = (word ?? "") + s;
      i = j + 1;
    } else if (c === "#" && word === null) {
      while (i < command.length && command[i] !== "\n") i++;
    } else if (c === " " || c === "\t") {
      endWord();
      i++;
    } else if (c === "\n") {
      endSeg();
      i = skipHeredocs(command, i + 1, heredocs);
      heredocs = [];
    } else if (c === ";" || c === "|" || c === "(" || c === ")") {
      endSeg();
      i++;
    } else if (c === "&") {
      if (command[i + 1] === ">") {
        endWord();
        redirect = true;
        i += command[i + 2] === ">" ? 3 : 2;
      } else {
        endSeg();
        i++;
      }
    } else if (c === ">") {
      fdOrEnd();
      redirect = true;
      i++;
      if (command[i] === ">" || command[i] === "|") i++;
      if (command[i] === "&") {
        dup = true;
        i++;
      }
    } else if (c === "<") {
      fdOrEnd();
      if (command[i + 1] === "<" && command[i + 2] !== "<") {
        i += command[i + 2] === "-" ? 3 : 2;
        heredocNext = true;
      } else i += command[i + 1] === "<" ? 3 : command[i + 1] === "&" ? 2 : 1;
    } else {
      word = (word ?? "") + c;
      i++;
    }
  }
  endSeg();
  return segments;
}

const FILE_COMMANDS = new Set(["tee", "rm", "mv", "cp", "ln", "chmod", "chown", "truncate", "dd", "install", "touch", "mkdir", "rmdir", "unlink", "patch"]);
/** Commands that delete or rename what they name, so a directory counts for every file under it. */
const TREE_COMMANDS = new Set(["rm", "rmdir", "mv"]);
const GIT_WRITES = new Set(["config", "apply", "checkout", "restore", "rm", "mv"]);
/** git's global options that take the next word as their value. */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/** Whether a sed or perl switch cluster turns on in-place editing; `takesRest` are the switches whose argument is the rest of the word. */
function inPlace(word: string, takesRest: string): boolean {
  if (word.startsWith("--")) return /^--in-place(=|$)/.test(word);
  if (!word.startsWith("-")) return false;
  for (const ch of word.slice(1)) {
    if (ch === "i") return true;
    if (takesRest.includes(ch)) return false;
  }
  return false;
}

interface Indicator {
  write: boolean;
  tree: boolean;
  /** Paths the command writes without naming them, relative to `base`. */
  implicit: string[];
  /** `git -C <dir>`. */
  base?: string;
}

function indicator(words: string[]): Indicator {
  const names = words.map((w) => w.slice(w.lastIndexOf("/") + 1));
  const out: Indicator = { write: names.some((n) => FILE_COMMANDS.has(n)), tree: names.some((n) => TREE_COMMANDS.has(n)), implicit: [] };
  const sed = names.indexOf("sed");
  if (sed >= 0 && words.slice(sed + 1).some((w) => inPlace(w, "efl"))) out.write = true;
  const perl = names.indexOf("perl");
  if (perl >= 0 && words.slice(perl + 1).some((w) => inPlace(w, "eEMmIxFlCdDV0"))) out.write = true;
  const git = names.indexOf("git");
  if (git >= 0) {
    let j = git + 1;
    for (; j < words.length; j++) {
      const w = words[j]!;
      const value = words[j + 1];
      if (w === "-C" && value !== undefined) out.base = value;
      if (GIT_VALUE_OPTIONS.has(w)) j++;
      else if (!w.startsWith("-")) break;
    }
    const sub = words[j];
    const rest = words.slice(j + 1);
    if (sub === "config") {
      const read = rest[0] === "get" || rest[0] === "list" || rest.some((w) => w.startsWith("--get") || w === "--list" || w === "-l");
      if (!read) {
        out.write = true;
        out.implicit.push(".git/config");
      }
    } else if (sub !== undefined && GIT_WRITES.has(sub)) {
      out.write = true;
      if (sub === "rm" || sub === "mv") out.tree = true;
    }
  }
  return out;
}

/** The most entries a glob expansion or a directory walk looks at. */
const WALK_LIMIT = 2000;

/** One path segment of a shell glob as a RegExp: `*`, `?` and `[...]`, never matching a leading "." (no dotglob). */
function segmentGlob(part: string): RegExp | undefined {
  let src = "";
  for (let i = 0; i < part.length; i++) {
    const c = part[i]!;
    if (c === "*") src += "[^/]*";
    else if (c === "?") src += "[^/]";
    else if (c === "[" && part.indexOf("]", i + 2) > 0) {
      const j = part.indexOf("]", i + 2);
      const cls = part.slice(i + 1, j);
      src += `[${cls.startsWith("!") ? `^${cls.slice(1)}` : cls}]`;
      i = j;
    } else src += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  try {
    return new RegExp(`^${part.startsWith(".") ? "" : "(?!\\.)"}${src}$`, "u");
  } catch {
    return undefined;
  }
}

/** The paths a shell glob names, expanded segment by segment against the filesystem. */
function expand(abs: string): string[] {
  let paths = ["/"];
  for (const part of abs.split("/").filter(Boolean)) {
    const re = /[*?[]/.test(part) ? segmentGlob(part) : undefined;
    const next: string[] = [];
    for (const p of paths) {
      if (re === undefined) next.push(join(p, part));
      else {
        let names: string[] = [];
        try {
          names = readdirSync(p);
        } catch {
          // not a directory
        }
        for (const n of names) if (re.test(n)) next.push(join(p, n));
      }
    }
    paths = next.slice(0, WALK_LIMIT);
  }
  return paths;
}

/** The first protected path under a worktree directory, breadth first, or undefined. */
function protectedUnder(dir: string, r: Roots): string | undefined {
  const queue = [dir];
  let seen = 0;
  while (queue.length > 0) {
    const d = queue.shift()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(d);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (++seen > WALK_LIMIT) return undefined;
      const p = join(d, name);
      const rel = relTo(r.work, p);
      if (isProtected(r.table, rel)) return rel;
      try {
        if (lstatSync(p).isDirectory()) queue.push(p);
      } catch {
        // gone
      }
    }
  }
  return undefined;
}

export interface ShellContext {
  cwd: string;
  home: string;
  roots: Roots;
  /** Pi's agent dir, real. */
  piDir: string;
}

export interface ShellBlock {
  rule: "shell-write";
  reason: string;
  path: string;
}

/** What one candidate word, resolved, writes to that rule 7 refuses. */
function refused(abs: string, tree: boolean, c: ShellContext): ShellBlock | undefined {
  let real: string;
  try {
    real = realPath(abs);
  } catch {
    return undefined;
  }
  const r = c.roots;
  if (within(real, r.work)) {
    const rel = relTo(r.work, real);
    if (rel !== "" && isProtected(r.table, rel)) return { rule: "shell-write", reason: `this command writes to the protected path ${rel}`, path: rel };
    if (tree) {
      let dir = false;
      try {
        dir = lstatSync(real).isDirectory();
      } catch {
        // doesn't exist
      }
      const found = dir ? protectedUnder(real, r) : undefined;
      if (found !== undefined) return { rule: "shell-write", reason: `this command writes to the protected path ${found}`, path: found };
    }
    return undefined;
  }
  if (within(real, c.piDir)) return { rule: "shell-write", reason: `this command writes into Pi's agent dir (${real})`, path: real };
  if (within(real, r.ledger)) return { rule: "shell-write", reason: `this command writes into hapi-guard's own budget ledger (${real})`, path: real };
  return undefined;
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Rule 7 for one bash command: the first write it plainly makes to a protected path, or undefined. */
export function checkShell(command: string, c: ShellContext): ShellBlock | undefined {
  let dir = c.cwd;
  const tilde = (w: string) => (w === "~" ? c.home : w.startsWith("~/") ? join(c.home, w.slice(2)) : w);
  for (const { words, redirects } of parseShell(command)) {
    const head = words.filter((w) => !ENV_ASSIGNMENT.test(w));
    if (head[0] === "cd" || head[0] === "pushd") {
      const to = head[1];
      if (to !== "-") dir = resolve(dir, tilde(to ?? c.home));
      continue;
    }
    const ind = indicator(words);
    const candidates: [word: string, tree: boolean, base: string][] = redirects.map((w) => [w, false, dir]);
    if (ind.write) {
      for (const w of words) {
        if (!w.startsWith("-")) candidates.push([w, ind.tree, dir]);
        const eq = w.indexOf("=");
        if (eq > 0 && eq < w.length - 1) candidates.push([w.slice(eq + 1), ind.tree, dir]);
      }
      const base = ind.base === undefined ? dir : resolve(dir, tilde(ind.base));
      for (const p of ind.implicit) candidates.push([p, false, base]);
    }
    for (const [word, tree, base] of candidates) {
      const abs = resolve(base, tilde(word));
      for (const path of /[*?[]/.test(word) ? expand(abs) : [abs]) {
        const hit = refused(path, tree, c);
        if (hit) return hit;
      }
    }
  }
  return undefined;
}
