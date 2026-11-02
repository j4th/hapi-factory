/**
 * Rule 7 (design §3.3): a best-effort check that blocks a `bash` command which
 * plainly writes to a protected path. It is a signal, not a boundary: an
 * interpreter one-liner (`python3 -c "open('AGENTS.md','w')"`), a variable or a
 * command substitution naming the path, `find -delete`, or a patch whose
 * targets are inside the patch file all get past it. The boundary for protected
 * files is the host-side diff gate (design §3.1), and the next node's
 * session_start checks catch a planted Pi dir or worktree.
 *
 * **Rule 7 is frozen** (the Task 10 review's ruling, fix round 2): no new
 * option specs and no new readers. What it still misses is registered as one
 * accepted residual, H-256 (docs/superpowers/plans/handoffs.md), behind the
 * host's protected-path diff gate (H-203).
 *
 * The command is split into simple commands (on `;`, `&`, `&&`, `|`, `||`,
 * newlines and parentheses) with shell quoting, `#` comments and heredoc bodies
 * handled. In each, the **command word** is the first word past any env
 * assignments, the shell's reserved words (`then`, `do`, `!`, `{` and the
 * rest) and any wrapper (`sudo`, `env`, `xargs`, `nohup`, `timeout` and the
 * like, WRAPPERS) with its `-` options, their values (`xargs -n 1 rm`, `sudo
 * -u root rm`) and a leading count (`timeout 5 rm`), and past `function <name>`.
 * `env`'s and `sudo`'s options are read exactly (WRAPPER_SPECS; `env -` is
 * `-i`): `env -C d` and `sudo -D d` (`--chdir`) run the command in `d`, each
 * relative to the wrapper before it, so its targets are judged there too; an
 * option either doesn't list, a directory option without its value, or `sudo
 * -R` (a new root) takes the broad rule. `eval`'s arguments, `env -S`'s string
 * (its escapes converted, read as `env <string> <rest>`, so its own `-C` counts;
 * one holding `$` blocks) and a shell's `-c` script (`sh`, `bash`, `dash`,
 * `zsh`, `ksh`) are read again as commands of their own. Only the command
 * word's basename is tested (`/bin/rm` is `rm`), so `grep -n install AGENTS.md`
 * writes nothing.
 *
 * A segment led by an **opaque wrapper** (OPAQUE: `watch`, `flock`, `chroot`,
 * `strace`, `fakeroot`, `parallel`, `su`, `runuser` and the like), which runs
 * its command in a way this rule can't follow, takes **the broad rule**, Plan
 * 02's in full: a file command's name anywhere, sed or perl with an in-place
 * switch after it, or a git write makes every word and every `=` value a
 * target; its words, joined, are also read again as commands, by the broad rule
 * too, so a quoted command string (`watch 'rm AGENTS.md'`) counts. (`eval` is
 * read exactly instead.) Any other command word is read as itself, never
 * broadly: rule 7 doesn't read `rsync`, `tar -x` or an archive tool. Options are
 * read as GNU getopt reads them: an exact long name wins, else any prefix
 * (`--targ`, `--ex=`, `--in-pl`), a prefix of a flag read as the flag, an
 * ambiguous one counting as each option it could be. The write indicators, and
 * the words each one writes (its **targets**):
 *
 * - an output redirection (`>`, `>>`, `>|`, `&>`, `N>`), of any simple command:
 *   its target;
 * - `cp`, `install` and `ln`: the `-t`/`--target-directory` value, else the last
 *   operand, and in a target directory (`-t`, a trailing "/", one that exists,
 *   or one a `mkdir` earlier in the command makes) the file each source makes
 *   there, by its name past any trailing "/" (a glob source by each match's), or
 *   with `--parents` its whole path; `-T` puts the source at the target itself.
 *   A recursive `cp` (`-r`, `-R`, `-a`, `--recursive`, `--archive`) walks each
 *   source directory (past DEPENDENCY_DIRS; with `-L`, through links to
 *   directories, each real one once) and judges every file where it lands
 *   (`T/<name>/...` in a target directory, else `T/...`, and `T/...` for an
 *   `S/.` source or with `-T`). A copy that lands wholly outside the worktree
 *   and the guard's dirs isn't walked; one with more than WALK_LIMIT files, or a
 *   command whose copies hold more than COPY_BUDGET, blocks, so the walk fails
 *   closed and stays cheap. `ln` with one operand makes `./<name>`, and
 *   `install -d` makes every operand;
 * - `dd`: its `of=` values;
 * - `mv` and the other file commands (`tee`, `rm`, `chmod`, `chown`,
 *   `truncate`, `touch`, `mkdir`, `rmdir`, `unlink`, `patch`): every operand,
 *   and the value after `=`;
 * - an in-place edit (`sed -i`/`--in-place`, `perl -i`): every operand but the
 *   script (the first operand, unless `-e`/`--expression`/`-f`, or perl's
 *   `-e`/`-E`, gives it), so `sed -i 's/../X/' notes.md` targets notes.md alone;
 * - git's `config` (not `--get`/`--list`; it writes `.git/config`), `apply`,
 *   `checkout`, `restore`, `rm` and `mv`: every word, and the value after `=`;
 * - `find` with `-exec`, `-execdir`, `-ok` or `-okdir` whose command, read as
 *   any simple command is, writes (or is opaque): every word, as git's.
 *
 * The **directories** a target is resolved against: the cwd, and every
 * directory a `cd` or `pushd` earlier in the command may have moved to, all at
 * once. A `cd` in a subshell, a pipeline or behind `&&`/`||` may or may not
 * have run, so each later target is checked against the old directories and
 * the new ones, and blocks if any lands on a protected path (H-223(b)). `cd`'s
 * `--`, `-L`, `-P`, `-e` and `-@` are parsed; any other option blocks, since
 * where the later words land can't be known; `cd -`, `popd` and a `pushd` that
 * only rotates add no directory. An operand holding `$`, a backtick or a glob
 * character, or a `~` form other than `~` and `~/...`, blocks the same way.
 * When CDPATH or OLDPWD is in play (a word of the command, or of the text read
 * again, may set either: setsCdVars; or the shell's env sets CDPATH), a `cd` to
 * a name not led by "." or "/" (or exactly `~` or `~/...`), and `cd -`, block
 * too. Past MAX_DIRS directories, the command blocks.
 *
 * A target blocks when it resolves (`~`, symlinks and a shell glob's expansion
 * applied; a glob is judged as written too, since bash keeps one that matches
 * nothing and a quoted one isn't a glob) to a protected path of the worktree, or into Pi's agent dir, the
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
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
/** Commands that run the command after them, past their options. */
const WRAPPERS = new Set(["sudo", "doas", "env", "xargs", "command", "builtin", "exec", "nohup", "nice", "ionice", "time", "timeout", "stdbuf", "setsid", "busybox"]);
/**
 * Commands that run another command in a way this rule can't follow (their own syntax for it, a new root, a script,
 * a trace): a segment led by one is judged by the broad rule (broadIndicator).
 */
const OPAQUE = new Set([
  "eval", "coproc", "watch", "chroot", "flock", "unshare", "nsenter", "strace", "ltrace", "fakeroot", "parallel", "su", "runuser", "script",
  "setpriv", "prlimit", "taskset", "chrt", "numactl", "systemd-run", "firejail", "bwrap", "proot", "valgrind", "unbuffer", "rlwrap", "sg",
  "faketime", "torsocks", "proxychains", "proxychains4", "catchsegv",
]);
/** find's actions that run a command. */
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** A word's last path component, past any trailing "/": `/bin/rm` is `rm`, `a/b/` is `b`. */
const baseName = (w: string | undefined): string => {
  if (w === undefined) return "";
  const t = w.length > 1 ? w.replace(/\/+$/, "") : w;
  return t.slice(t.lastIndexOf("/") + 1);
};

/** How a command's options take values (parseArgs), and which of a wrapper's change its cwd or its root. */
interface OptionSpec {
  /** Short options whose value is the rest of the word, or else the next word. */
  next?: string;
  /** Short options whose value, if any, is the rest of the word (never the next). */
  rest?: string;
  /** Short options that take no value (a wrapper's: any other one takes the broad rule). */
  shortFlags?: string;
  /** Long options whose value is after "=", or else the next word. */
  long?: string[];
  /** Long options that take no value. */
  flags?: string[];
  /** Long options whose value, if any, is after "=" (never the next word). */
  optional?: string[];
  /** A wrapper's options that run the command in another directory, short and long. */
  chdir?: string[];
  /** A wrapper's options that run the command under another root. */
  chroot?: string[];
}

/** The wrappers whose options are read exactly (env -C, sudo -D): an option not listed here takes the broad rule. */
const WRAPPER_SPECS: Record<string, OptionSpec> = {
  env: {
    next: "uCSa",
    shortFlags: "i0v",
    long: ["unset", "chdir", "split-string", "argv0"],
    flags: ["ignore-environment", "null", "debug", "list-signal-handling", "help", "version"],
    optional: ["block-signal", "default-signal", "ignore-signal"],
    chdir: ["C", "chdir"],
  },
  sudo: {
    next: "aCcDgpRrTtUu",
    shortFlags: "ABbEeHhiKklNnPSsVv",
    long: ["close-from", "chdir", "group", "host", "prompt", "role", "type", "command-timeout", "other-user", "user", "chroot", "auth-type", "login-class"],
    flags: ["askpass", "background", "bell", "edit", "set-home", "help", "login", "remove-timestamp", "reset-timestamp", "list", "non-interactive", "no-update", "preserve-groups", "stdin", "shell", "version", "validate"],
    optional: ["preserve-env"],
    chdir: ["D", "chdir"],
    chroot: ["R", "chroot"],
  },
};

/**
 * What a `--name` stands for in `spec`, as GNU getopt reads it: an exact name wins; otherwise any option it is a
 * prefix of. A prefix of a flag as well as of a valued option is read as a flag (it takes no word, so the word after
 * stays an operand), and an ambiguous prefix counts as each option it could be.
 */
function longMatch(name: string, spec: OptionSpec): { kind: "value" | "flag" | "none"; names: string[] } {
  if (name === "") return { kind: "none", names: [] };
  const values = spec.long ?? [];
  const flags = [...(spec.flags ?? []), ...(spec.optional ?? [])];
  if (values.includes(name)) return { kind: "value", names: [name] };
  if (flags.includes(name)) return { kind: "flag", names: [name] };
  const f = flags.filter((o) => o.startsWith(name));
  const v = values.filter((o) => o.startsWith(name));
  if (f.length > 0) return { kind: "flag", names: [...f, ...v] };
  return v.length > 0 ? { kind: "value", names: v } : { kind: "none", names: [] };
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
      const m = longMatch(name, spec);
      const keys = m.names.length > 0 ? m.names : [name];
      const value = eq >= 0 ? w.slice(eq + 1) : m.kind === "value" && i + 1 < args.length ? args[++i]! : "";
      for (const k of keys) put(k, value);
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

/** A simple command's command word, and what its wrappers say about how it runs (see the module comment). */
interface Head {
  /** The command word's index; `words.length` when there is none. */
  at: number;
  /** Directories the wrappers run it in (`env -C`, `sudo -D`), as given, outermost first: each is relative to the one before. */
  chdirs: string[];
  /** A wrapper this rule can't follow: an opaque one, a new root, an option it doesn't know, or a directory option without its value. */
  broad: boolean;
  /** Text the shell runs as commands of its own: `eval`'s arguments, `env -S`'s string, `sh -c`'s script. */
  more?: string;
  /** Text an opaque wrapper may run as commands (its words, joined): read again, by the broad rule. */
  moreBroad?: string;
  /** Why the command can't be read at all, when it can't (env -S with a `$`). */
  unreadable?: string;
}

/** The shells whose `-c` script is read as commands. */
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh"]);
/** env -S's escapes (coreutils env.c): `\_` is a space inside the string. */
const ENV_ESCAPES: Record<string, string> = { _: " ", t: "\t", n: "\n", r: "\r", v: "\v", f: "\f", "\\": "\\", '"': '"', "'": "'", "#": "#", $: "$" };

/** The command word of a simple command, past assignments, reserved words, `function <name>` and wrappers. */
export function headOf(words: string[]): Head {
  const out: Head = { at: words.length, chdirs: [], broad: false };
  /** A word that is a wrapper option's value or a count, not a command: after an option (`-n 1`), or a number or duration (`timeout 5s`). */
  const valueLike = (k: number): boolean => {
    const w = words[k]!;
    const name = baseName(w);
    if (KNOWN.has(name) || WRAPPERS.has(name) || OPAQUE.has(name)) return false;
    const prev = words[k - 1]!;
    return (prev.startsWith("-") && prev !== "--" && !prev.includes("=")) || /^\d[\d.]*[smhd]?$/.test(w);
  };
  let i = 0;
  for (;;) {
    while (i < words.length && (ENV_ASSIGNMENT.test(words[i]!) || RESERVED.has(words[i]!))) i++;
    if (words[i] === "function") {
      i += 2;
      continue;
    }
    const name = baseName(words[i]);
    if (!WRAPPERS.has(name)) {
      out.at = i;
      const args = words.slice(i + 1);
      // eval's text is read again as commands, exactly; an opaque wrapper's words, by the broad rule; a shell's -c script, exactly.
      if (name === "eval") out.more = args.join(" ");
      else if (OPAQUE.has(name)) {
        out.broad = true;
        out.moreBroad = args.join(" ");
      } else if (SHELLS.has(name)) {
        const c = args.findIndex((w) => /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
        const script = c < 0 ? undefined : args.slice(c + 1).find((w) => !/^[-+]/.test(w));
        if (script !== undefined) out.more = script;
      }
      return out;
    }
    i++;
    const spec = WRAPPER_SPECS[name];
    if (spec === undefined) {
      while (i < words.length && ((words[i]!.startsWith("-") && words[i] !== "-") || ENV_ASSIGNMENT.test(words[i]!) || valueLike(i))) i++;
      continue;
    }
    // env and sudo: their options read exactly, for the directory or the root they give the command; one this
    // rule doesn't know takes the broad rule.
    const take = (key: string, value: string | undefined) => {
      if (spec.chroot?.includes(key)) out.broad = true;
      if (spec.chdir?.includes(key)) {
        if (value === undefined || value === "") out.broad = true;
        else out.chdirs.push(value);
      }
      if (name === "env" && (key === "S" || key === "split-string") && value !== undefined) {
        // env -S splits its string itself (its own escapes, `\_` a space) and expands `${VAR}`: read it as `env <string> <rest>`.
        if (value.includes("$")) out.unreadable = "this command's env -S string holds a $, so what it runs can't be known";
        const text = value.replace(/\\(.)/g, (m, ch: string) => ENV_ESCAPES[ch] ?? m);
        out.more = ["env", text, ...words.slice(i + 1)].join(" ");
      }
    };
    while (i < words.length) {
      const w = words[i]!;
      if (w === "--") {
        i++;
        break;
      }
      if (ENV_ASSIGNMENT.test(w) || (name === "env" && w === "-")) {
        i++;
        continue;
      }
      if (w.startsWith("--")) {
        const eq = w.indexOf("=");
        const m = longMatch(eq < 0 ? w.slice(2) : w.slice(2, eq), spec);
        if (m.kind === "none") out.broad = true;
        if (m.kind === "value") {
          const value = eq >= 0 ? w.slice(eq + 1) : words[++i];
          for (const k of m.names) take(k, value);
        }
        i++;
        continue;
      }
      if (w.length > 1 && w.startsWith("-")) {
        for (let k = 1; k < w.length; k++) {
          const ch = w[k]!;
          if (spec.shortFlags?.includes(ch)) continue;
          if (!spec.next?.includes(ch)) {
            out.broad = true;
            break;
          }
          const tail = w.slice(k + 1);
          take(ch, tail !== "" ? tail : words[++i]);
          break;
        }
        i++;
        continue;
      }
      break;
    }
  }
}

/** The index of a simple command's command word (headOf). */
export const commandAt = (words: string[]): number => headOf(words).at;

/** Whether a sed or perl switch cluster turns on in-place editing (`--in-place` or any prefix of it); `takesRest` are the switches whose argument is the rest of the word. */
function inPlace(word: string, takesRest: string): boolean {
  if (word.startsWith("--")) {
    const name = word.slice(2).split("=")[0]!;
    return name !== "" && "in-place".startsWith(name);
  }
  if (!word.startsWith("-")) return false;
  for (const ch of word.slice(1)) {
    if (ch === "i") return true;
    if (takesRest.includes(ch)) return false;
  }
  return false;
}

/**
 * A word a command writes. `from`: a copy's sources, each of which makes a file of its name inside the word when the
 * word is a directory (`always`: it is one); with `recursive`, each source directory's tree lands under it. `flat`
 * (`cp -T`) puts a source at the word itself, `parents` (`cp --parents`) under its whole relative path, and `deref`
 * (`cp -L`) follows the links in it.
 */
interface Target {
  word: string;
  from?: string[];
  always?: boolean;
  recursive?: boolean;
  flat?: boolean;
  parents?: boolean;
  deref?: boolean;
}

/** The value after "=" in each word that has one (`of=x`, `--directory=x`). */
const eqValues = (words: string[]): string[] =>
  words.flatMap((w) => {
    const eq = w.indexOf("=");
    return eq > 0 && eq < w.length - 1 ? [w.slice(eq + 1)] : [];
  });
/** Every word but options, and the value after "=": what git, find and the broad rule name. */
const everyWord = (words: string[]): Target[] => [...words.filter((w) => !w.startsWith("-")), ...eqValues(words)].map((word) => ({ word }));

const COPY_SPECS: Record<string, OptionSpec> = {
  cp: {
    next: "tS",
    long: ["target-directory", "suffix", "sparse", "no-preserve"],
    flags: ["recursive", "archive", "no-target-directory", "dereference", "parents", "no-dereference"],
    optional: ["preserve", "reflink", "backup", "update"],
  },
  install: {
    next: "tSmog",
    long: ["target-directory", "suffix", "mode", "owner", "group", "strip-program"],
    flags: ["strip", "directory", "no-target-directory"],
    optional: ["backup", "context"],
  },
  ln: { next: "tS", long: ["target-directory", "suffix"], flags: ["no-target-directory", "symbolic"], optional: ["backup"] },
};

/** Whether parseArgs' values hold a switch: a short letter of `short`, or a long option `long` names (or a prefix of one). */
const has = (values: Map<string, string[]>, short: string, ...long: string[]): boolean =>
  [...values.keys()].some((k) => (k.length === 1 ? short.includes(k) : long.some((l) => l.startsWith(k))));

/** A source's path as `cp --parents` keeps it under the target: without a leading "/" or "./", or a trailing "/". */
const relPath = (s: string): string => s.replace(/^(\.?\/)+/, "").replace(/\/+$/, "");

/** cp's, install's and ln's targets (see the module comment). */
function copyTargets(cmd: string, args: string[]): Target[] {
  const { operands, values } = parseArgs(args, COPY_SPECS[cmd]!);
  if (cmd === "install" && has(values, "d", "directory")) return operands.map((word) => ({ word }));
  const dirs = (values.get("target-directory") ?? []).concat(values.get("t") ?? []).filter((d) => d !== "");
  const how = {
    ...(cmd === "cp" && has(values, "", "parents") ? { parents: true } : {}),
    ...(cmd === "cp" && has(values, "rRa", "recursive", "archive") ? { recursive: true } : {}),
    ...(has(values, "T", "no-target-directory") ? { flat: true } : {}),
    ...(cmd === "cp" && has(values, "L", "dereference") ? { deref: true } : {}),
  };
  if (dirs.length > 0) return dirs.map((word) => ({ word, from: operands, always: true, ...how }));
  if (operands.length === 0) return [];
  if (operands.length === 1) return cmd === "ln" ? [{ word: baseName(operands[0]) || operands[0]! }] : [];
  return [{ word: operands.at(-1)!, from: operands.slice(0, -1), ...how }];
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

/** git's write subcommands, from the word `git` at `g`: whether it writes, deletes, and the paths it writes unnamed. */
function gitWrites(words: string[], g: number, out: Indicator): void {
  let j = g + 1;
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

/**
 * The broad rule, for a segment this rule can't follow (an opaque wrapper, a new root, a directory it can't read):
 * Plan 02's rule in full. A file command's name anywhere, sed or perl with an in-place switch after it, or a git
 * write makes every word, and every `=` value, a target; any of `rm`, `rmdir` and `mv` makes them trees.
 */
function broadIndicator(words: string[]): Indicator {
  const names = words.map(baseName);
  const out: Indicator = { write: names.some((n) => FILE_COMMANDS.has(n)), tree: names.some((n) => TREE_COMMANDS.has(n)), targets: [], implicit: [] };
  const sed = names.indexOf("sed");
  if (sed >= 0 && words.slice(sed + 1).some((w) => inPlace(w, "efl"))) out.write = true;
  const perl = names.indexOf("perl");
  if (perl >= 0 && words.slice(perl + 1).some((w) => inPlace(w, "eEMmIxFlCdDV0"))) out.write = true;
  const git = names.indexOf("git");
  if (git >= 0) gitWrites(words, git, out);
  if (out.write) out.targets = everyWord(words);
  return out;
}

/** What one simple command writes (see the module comment). */
function indicator(words: string[], head: Head): Indicator {
  if (head.broad) return broadIndicator(words);
  const at = head.at;
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
    gitWrites(words, at, out);
    if (out.write) out.targets = everyWord(words);
  } else if (cmd === "find") {
    // Each -exec's command, read as any simple command is: a write there makes every word of the find a target.
    for (let k = 0; k < args.length; k++) {
      if (!FIND_EXEC.has(args[k]!)) continue;
      let end = k + 1;
      while (end < args.length && args[end] !== ";" && args[end] !== "+") end++;
      const run = args.slice(k + 1, end);
      const inner = headOf(run);
      const ran = indicator(run, inner);
      if (ran.write || inner.broad) {
        out.write = true;
        out.tree ||= ran.tree;
      }
      k = end;
    }
    if (out.write) out.targets = everyWord(words);
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
  /** Whether the shell's env sets CDPATH, so a relative `cd` may go anywhere (index.ts reads it from the guard's env). */
  cdpath?: boolean;
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
/** The most times one command's `eval`, `env -S`, `sh -c` or opaque text is read again as commands. */
const MAX_NESTED = 32;
/** The most entries all of one command's recursive copies may walk before it blocks: the walk's cost is the guard's. */
const COPY_BUDGET = 4 * WALK_LIMIT;

/** Whether a word has a ".." segment: where a logical and a physical `cd` can part. */
const hasDotDot = (w: string): boolean => w.split("/").includes("..");

/** Builtins that can set a shell variable, CDPATH or OLDPWD among them, from their words. */
const ASSIGNERS = new Set(["export", "declare", "typeset", "readonly", "local", "printf", "read", "mapfile", "readarray", "getopts", "let", "eval", "source", ".", "trap"]);
const CD_VARS = /^(CDPATH|OLDPWD)(\[[^\]]*\])?\+?=/;

/**
 * Whether a simple command may set CDPATH or OLDPWD, from its parsed words: an assignment to either before the
 * command word or among an assigning builtin's words, either name as such a builtin's word (`printf -v CDPATH`,
 * `read OLDPWD`), or such a builtin's word holding `$` or a backtick (a name this rule can't read).
 */
function setsCdVars(words: string[]): boolean {
  const at = headOf(words).at;
  if (words.slice(0, at).some((w) => CD_VARS.test(w))) return true;
  if (!ASSIGNERS.has(baseName(words[at]))) return false;
  return words.slice(at + 1).some((w) => CD_VARS.test(w) || w === "CDPATH" || w === "OLDPWD" || /[$`]/.test(w));
}

/** Rule 7 for one bash command: the first write it plainly makes to a protected path, or undefined. */
export function checkShell(command: string, c: ShellContext): ShellBlock | undefined {
  /** Every directory the command may be in by now: the cwd, and where each earlier cd or pushd may have gone. */
  let dirs = [c.cwd];
  /** Directories an earlier `mkdir` in the command makes, as resolved lexically. */
  const made = new Set<string>();
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
      return made.has(resolve(p));
    }
  };
  /** The paths a word names: a glob's matches, and the word as written too (bash keeps a glob that matches nothing, and a quoted one isn't a glob). */
  const paths = (word: string, abs: string) => (/[*?[]/.test(word) ? [...new Set([...expand(abs), abs])] : [abs]);
  /** Whether a path is in the worktree, Pi's agent dir, the ledger or the log's dir: somewhere a write can be refused. */
  const reachable = (p: string): boolean => {
    if (namedRel(c.roots, p) !== undefined) return true;
    let real: string;
    try {
      real = realPath(p);
    } catch {
      return true;
    }
    return [c.roots.work, c.piDir, c.roots.ledger, c.out].some((root) => within(real, root));
  };
  let walked = 0;
  /**
   * A recursive copy of the directory `src` to `root`: each file it makes, judged where it lands. A copy that lands
   * wholly outside the refusable roots isn't walked; one too big to walk blocks, as does a command whose copies
   * together are (COPY_BUDGET). With `deref` (cp -L), links to directories are followed, each real one once.
   */
  const copied = (src: string, root: string, word: string, deref: boolean): ShellBlock | undefined => {
    if (!reachable(root)) return undefined;
    const tooBig = (what: string): ShellBlock => ({ rule: "shell-write", reason: `this command copies ${what} into ${word}, too many to check where they land`, path: root });
    const queue: [dir: string, rel: string][] = [[src, ""]];
    const visited = new Set<string>();
    let seen = 0;
    while (queue.length > 0) {
      const [dir, rel] = queue.shift()!;
      let entries: string[] = [];
      try {
        if (deref) {
          const real = realpathSync(dir);
          if (visited.has(real)) continue;
          visited.add(real);
        }
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (++seen > WALK_LIMIT) return tooBig(`more than ${WALK_LIMIT} files`);
        if (++walked > COPY_BUDGET) return tooBig(`more than ${COPY_BUDGET} files in all`);
        const r = rel === "" ? name : `${rel}/${name}`;
        const hit = refused(step(root, r), step(word, r), false, c);
        if (hit) return hit;
        try {
          const p = step(dir, name);
          if (!DEPENDENCY_DIRS.has(name) && (deref ? statSync(p) : lstatSync(p)).isDirectory()) queue.push([p, r]);
        } catch {
          // gone, or a dangling link
        }
      }
    }
    return undefined;
  };
  /** Where a target word, resolved against `base`, lands, as refused judges it; the files it makes inside a target dir; a recursive copy's tree. */
  const judge = (t: Target, tree: boolean, base: string): ShellBlock | undefined => {
    for (const path of paths(t.word, under(base, t.word))) {
      const hit = refused(path, t.word, tree, c);
      if (hit) return hit;
      const asDir = !t.flat && (t.always === true || t.word.endsWith("/") || isDir(path));
      for (const s of t.from ?? []) {
        // Each source as it expands (a glob's matches, and the word as written): its name, or with --parents its path.
        for (const src of paths(s, under(base, s))) {
          const named = s.startsWith("/") || !src.startsWith(`${base}/`) ? src : src.slice(base.length + 1);
          const sub = t.parents ? relPath(/[*?[]/.test(s) ? named : s) : baseName(/[*?[]/.test(s) ? named : s);
          const nameable = sub !== "" && sub !== "." && sub !== "..";
          if (asDir && nameable) {
            const inner = refused(step(path, sub), step(t.word, sub), false, c);
            if (inner) return inner;
          }
          if (!t.recursive || !isDir(src)) continue;
          // `cp -r S T` makes T/<S's name>/... in a target directory T, else T/...; `cp -r S/. T` and `cp -rT S T` make
          // T/...; `cp -r --parents S T` makes T/<S's path>/....
          const contents = s === "." || s.endsWith("/.") || s.endsWith("/./");
          const into = asDir && !contents && nameable;
          const hit2 = copied(src, into ? step(path, sub) : path, into ? step(t.word, sub) : t.word, t.deref === true);
          if (hit2) return hit2;
        }
      }
    }
    return undefined;
  };
  const cantFollow = (what: string): ShellBlock => ({ rule: "shell-write", reason: `this command's ${what} can't be followed, so where its later words land can't be known` });
  /** Each simple command still to read, and whether the broad rule judges it (it came from an opaque wrapper's words). */
  const queue: { seg: Segment; broad: boolean }[] = parseShell(command).map((seg) => ({ seg, broad: false }));
  /** CDPATH or OLDPWD may send a `cd` somewhere this rule can't see (H-223): read from the parsed words, and the env. */
  let cdUnknown = c.cdpath === true || queue.some((q) => setsCdVars(q.seg.words));
  let nested = 0;
  const reread = (text: string, broad: boolean): ShellBlock | undefined => {
    if (++nested > MAX_NESTED) return { rule: "shell-write", reason: `this command nests eval, env -S or sh -c more than ${MAX_NESTED} deep, so what it runs can't be known` };
    const segs = parseShell(text);
    if (segs.some((seg) => setsCdVars(seg.words))) cdUnknown = true;
    queue.unshift(...segs.map((seg) => ({ seg, broad })));
    return undefined;
  };
  while (queue.length > 0) {
    const { seg, broad } = queue.shift()!;
    const { words, redirects } = seg;
    const h = headOf(words);
    if (broad) h.broad = true;
    if (h.unreadable !== undefined) return { rule: "shell-write", reason: h.unreadable };
    // Read again as commands: eval's, env -S's and sh -c's text exactly, an opaque wrapper's words by the broad rule.
    const again = h.more !== undefined ? reread(h.more, broad) : h.moreBroad !== undefined ? reread(h.moreBroad, true) : undefined;
    if (again) return again;
    const head = words[h.at];
    const cd = !h.broad && (head === "cd" || head === "pushd" || head === "popd");
    const ind = cd ? undefined : indicator(words, h);
    // The shell opens a redirect where it is; a wrapper's directory (`env -C d`, `sudo -D d`) runs this command, and
    // only this one, there too, each relative to the one before (`env -C a sudo -D b` runs in a/b).
    for (const dir of dirs) {
      for (const word of redirects) {
        const hit = judge({ word }, false, dir);
        if (hit) return hit;
      }
    }
    const here = new Set(dirs);
    for (const d of dirs) {
      let cur = d;
      for (const v of h.chdirs) here.add((cur = resolve(cur, tilde(v))));
    }
    for (const dir of here) {
      for (const t of ind?.write ? ind.targets : []) {
        const hit = judge(t, ind!.tree, dir);
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
    if (!h.broad && baseName(head) === "mkdir") {
      // Each directory it makes, and with -p the ones above it, count as directories for the rest of the command.
      for (const d of here) {
        for (const op of parseArgs(words.slice(h.at + 1), { next: "m", long: ["mode"] }).operands) {
          for (let p = resolve(under(d, op)); p !== dirname(p) && !made.has(p); p = dirname(p)) made.add(p);
        }
      }
    }
    if (!cd || head === "popd") continue;
    // cd's and pushd's options (bash's `cd [-L|[-P [-e]] [-@]] [dir]`, `pushd [-n] [+N | -N | dir]`).
    const args = words.slice(h.at + 1);
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
      return cantFollow(`${head} ${w}`);
    }
    const to = args[i];
    const rotation = rotate || (head === "pushd" && to !== undefined && /^\+\d+$/.test(to));
    // An operand this rule can't resolve: a variable, a substitution, a glob, or a `~` form other than `~` and `~/`.
    if (!rotation && to !== undefined && (/[$`*?[]/.test(to) || (to.startsWith("~") && to !== "~" && !to.startsWith("~/")))) return cantFollow(`${head} ${to}`);
    // `cd -` goes to OLDPWD, and a relative name may go through CDPATH: unknowable when either is in play.
    if (!rotation && cdUnknown && (to === "-" || (to !== undefined && !/^[./]/.test(to) && to !== "~" && !to.startsWith("~/")))) return cantFollow(`${head} ${to}`);
    // `cd -` and `popd` go back to a directory already in `dirs`; so does a pushd with no operand, or a rotation.
    if (rotation || to === "-" || (head === "pushd" && to === undefined)) continue;
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
