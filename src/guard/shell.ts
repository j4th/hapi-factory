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
 * handled. In each, the **command word** is the first word past any env
 * assignments, the shell's reserved words (`then`, `do`, `!`, `{` and the
 * rest) and any wrapper (`sudo`, `env`, `xargs`, `nohup`, `timeout` and the
 * like, WRAPPERS) with its `-` options, their values (`xargs -n 1 rm`, `sudo
 * -u root rm`) and a leading count (`timeout 5 rm`), and past `function <name>`.
 * Only the command word's basename is tested (`/bin/rm` is `rm`), so `grep -n
 * install AGENTS.md` writes nothing. The write indicators, and the words each
 * one writes (its **targets**):
 *
 * - an output redirection (`>`, `>>`, `>|`, `&>`, `N>`), of any simple command:
 *   its target;
 * - `cp`, `install` and `ln`: the `-t`/`--target-directory` value, else the last
 *   operand, and in a target directory (`-t`, a trailing "/", or one that
 *   exists) the file each source makes there; `ln` with one operand makes
 *   `./<name>`, and `install -d` makes every operand;
 * - `dd`: its `of=` values;
 * - `mv` and the other file commands (`tee`, `rm`, `chmod`, `chown`,
 *   `truncate`, `touch`, `mkdir`, `rmdir`, `unlink`, `patch`): every operand,
 *   and the value after `=`;
 * - an in-place edit (`sed -i`/`--in-place`, `perl -i`): every operand but the
 *   script (the first operand, unless `-e`/`--expression`/`-f`, or perl's
 *   `-e`/`-E`, gives it), so `sed -i 's/../X/' notes.md` targets notes.md alone;
 * - git's `config` (not `--get`/`--list`; it writes `.git/config`), `apply`,
 *   `checkout`, `restore`, `rm` and `mv`: every word, and the value after `=`;
 * - `find` with `-exec`, `-execdir`, `-ok` or `-okdir` running a file command:
 *   every word, as git's.
 *
 * The **directories** a target is resolved against: the cwd, and every
 * directory a `cd` or `pushd` earlier in the command may have moved to, all at
 * once. A `cd` in a subshell, a pipeline or behind `&&`/`||` may or may not
 * have run, so each later target is checked against the old directories and
 * the new ones, and blocks if any lands on a protected path (H-223(b)). `cd`'s
 * `--`, `-L`, `-P`, `-e` and `-@` are parsed; any other option blocks, since
 * where the later words land can't be known; `cd -`, `popd` and a `pushd` that
 * only rotates add no directory. Past MAX_DIRS directories, the command blocks.
 *
 * A target blocks when it resolves (`~`, symlinks and a shell glob's expansion
 * applied) to a protected path of the worktree, or into Pi's agent dir, the
 * guard's ledger or the decision log's dir (`paths.out`). It is judged twice,
 * and the strictest wins: by its name, normalized lexically as the command
 * gives it (so `rm CLAUDE.md` blocks when CLAUDE.md is a link to an unprotected
 * file), and where it lands, resolved as the kernel resolves it (paths.ts,
 * realPath): with `obj -> .git/objects`, `obj/../hooks/x` is `.git/hooks/x`. A
 * target with a ".." after a component that doesn't exist blocks too, since
 * where it lands can't be known (`ln -s ... a && echo > a/../x` makes `a` in
 * the same command), and so does one through a symlink loop. The decision-log
 * refusal is a signal as well: the shell can still write there with an
 * interpreter, which the threat model keeps as a residual.
 *
 * `rm`, `rmdir`, `mv`, `git rm` and `git mv` on a directory also count every
 * file under it (breadth first, up to WALK_LIMIT entries, after which the rest
 * is unchecked), so `rm -rf .` blocks on the root's AGENTS.md or .git. The walk
 * never enters a dependency dir (DEPENDENCY_DIRS): installed packages ship
 * their own instruction files (bun-types has a CLAUDE.md), which no agent reads
 * as this repo's, so `rm -rf node_modules` stays allowed.
 */
import { lstatSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { isProtected, namedRel, realPath, relTo, type Roots, Unresolvable, within } from "./paths";

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
/** The commands this rule reads at the command position. */
const KNOWN = new Set([...FILE_COMMANDS, "sed", "perl", "git", "find"]);
/** The shell's reserved words that can come before a command in a simple command, as parseShell splits them. */
const RESERVED = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}"]);
/** Commands that run the command after them (and their options). */
const WRAPPERS = new Set(["sudo", "doas", "env", "xargs", "command", "builtin", "exec", "nohup", "nice", "ionice", "time", "timeout", "stdbuf", "setsid", "busybox"]);
/** find's actions that run a command. */
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** A word's last path component: `/bin/rm` is `rm`. */
const baseName = (w: string | undefined): string => (w === undefined ? "" : w.slice(w.lastIndexOf("/") + 1));

/** The index of a simple command's command word (see the module comment); `words.length` when it has none. */
export function commandAt(words: string[]): number {
  /** A word that is a wrapper option's value or a count, not a command: after an option (`-n 1`, `-u root`), or a number or duration (`timeout 5s`). */
  const valueLike = (k: number): boolean => {
    const w = words[k]!;
    if (KNOWN.has(baseName(w)) || WRAPPERS.has(baseName(w))) return false;
    const prev = words[k - 1]!;
    return (prev.startsWith("-") && prev !== "--" && !prev.includes("=")) || /^\d[\d.]*[smhd]?$/.test(w);
  };
  let i = 0;
  for (;;) {
    while (i < words.length && (ENV_ASSIGNMENT.test(words[i]!) || RESERVED.has(words[i]!))) i++;
    // `function f { ...`: the name is no command.
    if (words[i] === "function") {
      i += 2;
      continue;
    }
    if (!WRAPPERS.has(baseName(words[i]))) return i;
    i++;
    while (i < words.length) {
      const w = words[i]!;
      if ((w.startsWith("-") && w !== "-") || ENV_ASSIGNMENT.test(w) || valueLike(i)) i++;
      else break;
    }
  }
}

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

/** How a command's options take values, for parseArgs. */
interface OptionSpec {
  /** Short options whose value is the rest of the word, or else the next word. */
  next?: string;
  /** Short options whose value, if any, is the rest of the word (never the next). */
  rest?: string;
  /** Long options whose value is after "=", or else the next word. */
  long?: string[];
}

/** A command's arguments as GNU getopt reads them: its operands (all of them after `--`), and its option values by name. */
function parseArgs(args: string[], spec: OptionSpec): { operands: string[]; values: Map<string, string[]> } {
  const operands: string[] = [];
  const values = new Map<string, string[]>();
  const put = (k: string, v: string) => values.set(k, [...(values.get(k) ?? []), v]);
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    if (w === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (w.startsWith("--")) {
      const eq = w.indexOf("=");
      const name = eq < 0 ? w.slice(2) : w.slice(2, eq);
      if (eq >= 0) put(name, w.slice(eq + 1));
      else if (spec.long?.includes(name) && i + 1 < args.length) put(name, args[++i]!);
      else put(name, "");
      continue;
    }
    if (w.length > 1 && w.startsWith("-")) {
      for (let k = 1; k < w.length; k++) {
        const ch = w[k]!;
        const tail = w.slice(k + 1);
        if (spec.next?.includes(ch)) {
          if (tail !== "") put(ch, tail);
          else if (i + 1 < args.length) put(ch, args[++i]!);
          break;
        }
        put(ch, spec.rest?.includes(ch) ? tail : "");
        if (spec.rest?.includes(ch)) break;
      }
      continue;
    }
    operands.push(w);
  }
  return { operands, values };
}

/** A word a command writes. `into`: the names it makes inside that word when the word is a directory; `always`: it is one. */
interface Target {
  word: string;
  into?: string[];
  always?: boolean;
}

/** The value after "=" in each word that has one (`of=x`, `--directory=x`). */
const eqValues = (words: string[]): string[] =>
  words.flatMap((w) => {
    const eq = w.indexOf("=");
    return eq > 0 && eq < w.length - 1 ? [w.slice(eq + 1)] : [];
  });
/** Every word but options, and the value after "=": what git and find name. */
const everyWord = (words: string[]): Target[] => [...words.filter((w) => !w.startsWith("-")), ...eqValues(words)].map((word) => ({ word }));

/** cp's, install's and ln's targets (see the module comment). */
function copyTargets(cmd: string, args: string[]): Target[] {
  const spec: OptionSpec = cmd === "install" ? { next: "tSmog", long: ["target-directory", "suffix", "mode", "owner", "group"] } : { next: "tS", long: ["target-directory", "suffix"] };
  const { operands, values } = parseArgs(args, spec);
  if (cmd === "install" && (values.has("d") || values.has("directory"))) return operands.map((word) => ({ word }));
  const dirs = [...(values.get("t") ?? []), ...(values.get("target-directory") ?? [])].filter((d) => d !== "");
  const names = (sources: string[]) => sources.map(baseName).filter((n) => n !== "" && n !== "." && n !== "..");
  if (dirs.length > 0) return dirs.map((word) => ({ word, into: names(operands), always: true }));
  if (operands.length === 0) return [];
  if (operands.length === 1) return cmd === "ln" ? [{ word: baseName(operands[0]) || operands[0]! }] : [];
  return [{ word: operands.at(-1)!, into: names(operands.slice(0, -1)) }];
}

/** An in-place edit's targets: every operand but the script. `scripts` are the options that give the script instead. */
function editTargets(args: string[], spec: OptionSpec, scripts: string[]): Target[] {
  const { operands, values } = parseArgs(args, spec);
  const given = scripts.some((k) => values.has(k));
  return (given ? operands : operands.slice(1)).map((word) => ({ word }));
}

interface Indicator {
  write: boolean;
  tree: boolean;
  /** The words the command writes. */
  targets: Target[];
  /** Paths the command writes without naming them, relative to `base`. */
  implicit: string[];
  /** `git -C <dir>`. */
  base?: string;
}

/** What one simple command, with its command word at `at`, writes (see the module comment). */
function indicator(words: string[], at: number): Indicator {
  const cmd = baseName(words[at]);
  const args = words.slice(at + 1);
  const out: Indicator = { write: false, tree: false, targets: [], implicit: [] };
  if (FILE_COMMANDS.has(cmd)) {
    out.write = true;
    out.tree = TREE_COMMANDS.has(cmd);
    if (cmd === "cp" || cmd === "install" || cmd === "ln") out.targets = copyTargets(cmd, args);
    else if (cmd === "dd") out.targets = args.filter((w) => w.startsWith("of=") && w.length > 3).map((w) => ({ word: w.slice(3) }));
    else out.targets = [...parseArgs(args, {}).operands, ...eqValues(args)].map((word) => ({ word }));
  } else if (cmd === "sed" && args.some((w) => inPlace(w, "efl"))) {
    out.write = true;
    out.targets = editTargets(args, { next: "efl", rest: "i", long: ["expression", "file", "line-length"] }, ["e", "f", "expression", "file"]);
  } else if (cmd === "perl" && args.some((w) => inPlace(w, "eEMmIxFlCdDV0"))) {
    out.write = true;
    out.targets = editTargets(args, { next: "eE", rest: "iMmIxFlCdDV0" }, ["e", "E"]);
  } else if (cmd === "git") {
    let j = at + 1;
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
    if (out.write) out.targets = everyWord(words);
  } else if (cmd === "find") {
    const run = args.findIndex((w, k) => FIND_EXEC.has(w) && FILE_COMMANDS.has(baseName(args[k + 1])));
    if (run >= 0) {
      out.write = true;
      out.tree = TREE_COMMANDS.has(baseName(args[run + 1]));
      out.targets = everyWord(words);
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

/** `p` and one more segment, unnormalized: ".." stays for the kernel (and realPath) to apply. */
const step = (p: string, part: string): string => (p.endsWith("/") ? `${p}${part}` : `${p}/${part}`);

/** The paths a shell glob names, expanded segment by segment against the filesystem. */
function expand(abs: string): string[] {
  let paths = ["/"];
  for (const part of abs.split("/").filter(Boolean)) {
    const re = /[*?[]/.test(part) ? segmentGlob(part) : undefined;
    const next: string[] = [];
    for (const p of paths) {
      if (re === undefined) next.push(step(p, part));
      else {
        let names: string[] = [];
        try {
          names = readdirSync(p);
        } catch {
          // not a directory
        }
        for (const n of names) if (re.test(n)) next.push(step(p, n));
      }
    }
    paths = next.slice(0, WALK_LIMIT);
  }
  return paths;
}

/**
 * Package-manager install dirs the walk never enters: node_modules (npm, Bun,
 * pnpm, Yarn), bower_components, and Python's virtualenvs. A path named
 * directly still counts: `rm node_modules/x/CLAUDE.md` blocks.
 */
const DEPENDENCY_DIRS = new Set(["node_modules", "bower_components", ".venv", "venv"]);

/** The first protected path under a worktree directory, breadth first, or undefined. */
function protectedUnder(dir: string, r: Roots): string | undefined {
  if (relTo(r.work, dir).split("/").some((seg) => DEPENDENCY_DIRS.has(seg))) return undefined;
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
      const p = step(d, name);
      const rel = relTo(r.work, p);
      if (isProtected(r.table, rel)) return rel;
      try {
        if (!DEPENDENCY_DIRS.has(name) && lstatSync(p).isDirectory()) queue.push(p);
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
  /** The decision log's dir (`paths.out`), real. */
  out: string;
}

export interface ShellBlock {
  rule: "shell-write";
  reason: string;
  /** The path it judged; none for a cd it can't follow. */
  path?: string;
}

/** What one candidate word, resolved, writes to that rule 7 refuses. */
function refused(abs: string, word: string, tree: boolean, c: ShellContext): ShellBlock | undefined {
  // The name as the command gives it, lexically, then where it really lands: the strictest wins, so `rm CLAUDE.md`
  // blocks even when CLAUDE.md is a link to an unprotected file. The worktree root itself is no file to protect.
  const named = namedRel(c.roots, abs);
  if (named !== undefined && named !== "" && isProtected(c.roots.table, named)) {
    return { rule: "shell-write", reason: `this command writes to the protected path ${named}`, path: named };
  }
  let real: string;
  try {
    real = realPath(abs);
  } catch (e) {
    // realPath throws Unresolvable, or an Error past Linux's SYMLOOP_MAX links: the kernel's ELOOP.
    if (!(e instanceof Unresolvable)) return { rule: "shell-write", reason: `this command names ${word}, which goes through too many levels of symbolic links`, path: abs };
    return {
      rule: "shell-write",
      reason: `this command names ${word}, which goes through ${e.missing}, which doesn't exist, and then "..", so where it lands can't be known`,
      path: abs,
    };
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
  if (within(real, c.piDir)) return { rule: "shell-write", reason: `this command writes into Pi's agent dir (${c.piDir})`, path: real };
  if (within(real, r.ledger)) return { rule: "shell-write", reason: `this command writes into hapi-guard's own budget ledger (${r.ledger})`, path: real };
  if (within(real, c.out)) return { rule: "shell-write", reason: `this command writes into hapi-guard's decision log dir (${c.out})`, path: real };
  return undefined;
}

/** The most directories a command's `cd`s may have left it in before it blocks (see the module comment). */
const MAX_DIRS = 64;

/** Whether a word has a ".." segment: where a logical and a physical `cd` can part. */
const hasDotDot = (w: string): boolean => w.split("/").includes("..");

/** Rule 7 for one bash command: the first write it plainly makes to a protected path, or undefined. */
export function checkShell(command: string, c: ShellContext): ShellBlock | undefined {
  /** Every directory the command may be in by now: the cwd, and where each earlier cd or pushd may have gone. */
  let dirs = [c.cwd];
  const tilde = (w: string) => (w === "~" ? c.home : w.startsWith("~/") ? step(c.home, w.slice(2)) : w);
  /** A word as the kernel gets it: `~` expanded, relative to `base`, unnormalized. */
  const under = (base: string, w: string) => {
    const t = tilde(w);
    return t.startsWith("/") ? t : step(base, t);
  };
  const isDir = (p: string) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  /** Where a target word, resolved against `base`, lands, as refused judges it; and the files it makes inside a target dir. */
  const judge = (t: Target, tree: boolean, base: string): ShellBlock | undefined => {
    const abs = under(base, t.word);
    for (const path of /[*?[]/.test(t.word) ? expand(abs) : [abs]) {
      const hit = refused(path, t.word, tree, c);
      if (hit) return hit;
      if (t.into === undefined || !(t.always || t.word.endsWith("/") || isDir(path))) continue;
      for (const name of t.into) {
        const inner = refused(step(path, name), step(t.word, name), false, c);
        if (inner) return inner;
      }
    }
    return undefined;
  };
  for (const { words, redirects } of parseShell(command)) {
    const at = commandAt(words);
    const head = words[at];
    const cd = head === "cd" || head === "pushd" || head === "popd";
    const ind = cd ? undefined : indicator(words, at);
    const targets: [t: Target, tree: boolean][] = redirects.map((word) => [{ word }, false]);
    if (ind?.write) for (const t of ind.targets) targets.push([t, ind.tree]);
    for (const dir of dirs) {
      for (const [t, tree] of targets) {
        const hit = judge(t, tree, dir);
        if (hit) return hit;
      }
      if (ind?.write) {
        const base = ind.base === undefined ? dir : under(dir, ind.base);
        for (const p of ind.implicit) {
          const hit = judge({ word: p }, false, base);
          if (hit) return hit;
        }
      }
    }
    if (!cd || head === "popd") continue;
    // cd's and pushd's options (bash's `cd [-L|[-P [-e]] [-@]] [dir]`, `pushd [-n] [+N | -N | dir]`).
    const args = words.slice(at + 1);
    let i = 0;
    let rotate = false;
    for (; i < args.length; i++) {
      const w = args[i]!;
      if (w === "--") {
        i++;
        break;
      }
      if (w === "-" || !w.startsWith("-")) break;
      if (head === "cd" && /^-[LPe@]+$/.test(w)) continue;
      if (head === "pushd" && w === "-n") continue;
      if (head === "pushd" && /^-\d+$/.test(w)) {
        rotate = true;
        break;
      }
      return { rule: "shell-write", reason: `this command's ${head} ${w} can't be followed, so where its later words land can't be known` };
    }
    const to = args[i];
    // `cd -` and `popd` go back to a directory already in `dirs`; so does a pushd with no operand, or a rotation.
    if (rotate || to === "-" || (head === "pushd" && (to === undefined || /^\+\d+$/.test(to)))) continue;
    const target = to ?? c.home;
    const next = new Set(dirs);
    for (const d of dirs) {
      // bash's cd is logical by default: it collapses ".." in the name before it changes dir. A physical cd (-P, or
      // the fallback when the logical name doesn't exist) applies ".." after the link before it, as the kernel does.
      next.add(resolve(d, tilde(target)));
      if (hasDotDot(target)) {
        try {
          next.add(realPath(under(d, target)));
        } catch {
          // a cd the kernel can't follow fails, and leaves the shell where it was
        }
      }
    }
    if (next.size > MAX_DIRS) {
      return { rule: "shell-write", reason: `this command's cds may leave it in more than ${MAX_DIRS} directories, so where its later words land can't be known` };
    }
    dirs = [...next];
  }
  return undefined;
}
