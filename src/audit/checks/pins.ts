/**
 * pins.versions (spec §3, §11.6; Global Constraints: "Pin every tool, image
 * and plugin"): read from the checkout's own files, so it needs nothing
 * running.
 *
 * - mise.toml: every [tools] entry is an exact version (MAJOR.MINOR.PATCH,
 *   optionally with a pre-release or build suffix): never `latest`, a range
 *   or a prefix such as `3.14`, which mise reads as "the newest 3.14.x".
 * - stack/compose.yaml: every service's `image:` is pinned by digest, except
 *   a service built here, which must have `pull_policy: build` (so nothing
 *   pulls a registry image of that name) and whose Dockerfile is checked.
 * - each Dockerfile: every `FROM` and `COPY --from=` image by digest (an
 *   earlier stage's name is fine), and every package a `RUN` installs by
 *   name (apt-get, apt, apk, pip, uv, npm, bun, pnpm, yarn, go) at an exact
 *   version.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { COMPOSE_FILE } from "../../stack/up";
import { type AuditRun, type CheckResult, result } from "../types";

/** A compose service, the fields the audit reads. */
export interface ComposeService {
  image?: string;
  build?: string | { context?: string; dockerfile?: string };
  pull_policy?: string;
  user?: string;
}

/** stack/compose.yaml's services, merge keys resolved. */
export async function composeServices(root: string): Promise<Record<string, ComposeService>> {
  const doc = YAML.parse(await readFile(join(root, COMPOSE_FILE), "utf8"), { merge: true }) as { services?: Record<string, ComposeService> };
  return doc.services ?? {};
}

/** The Dockerfile a built service uses, relative to the checkout. */
export function dockerfileOf(s: ComposeService): string | undefined {
  if (s.build === undefined) return undefined;
  const context = typeof s.build === "string" ? s.build : (s.build.context ?? ".");
  const file = typeof s.build === "string" ? "Dockerfile" : (s.build.dockerfile ?? "Dockerfile");
  return join("stack", context, file);
}

const DIGEST = /@sha256:[0-9a-f]{64}$/;
const EXACT = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;

/**
 * A Dockerfile's instructions, comments dropped and line continuations joined, in Docker's order: comment lines
 * (and blank lines) go first, so a `#` line inside a continued RUN is neither read as words nor ends the RUN.
 * A heredoc body (`RUN <<EOF`) is not read as the RUN's command (docs/audit.md, "Not covered yet").
 */
function instructions(text: string): { op: string; args: string }[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"))
    .join("\n")
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((l) => {
      const m = /^(\S+)\s*(.*)$/.exec(l)!;
      return { op: m[1]!.toUpperCase(), args: m[2]! };
    });
}

/** The images a Dockerfile pulls, in order: FROM and COPY --from=, with the stage names before each. */
export function dockerfileImages(text: string): { kind: "FROM" | "COPY --from"; image: string; stages: Set<string> }[] {
  const stages = new Set<string>();
  const out: { kind: "FROM" | "COPY --from"; image: string; stages: Set<string> }[] = [];
  for (const { op, args } of instructions(text)) {
    if (op === "FROM") {
      const words = args.split(/\s+/).filter((w) => !w.startsWith("--"));
      out.push({ kind: "FROM", image: words[0] ?? "", stages: new Set(stages) });
      if (words[1]?.toUpperCase() === "AS" && words[2] !== undefined) stages.add(words[2].toLowerCase());
    } else if (op === "COPY" || op === "ADD") {
      const from = /--from=(\S+)/.exec(args)?.[1];
      if (from !== undefined) out.push({ kind: "COPY --from", image: from, stages: new Set(stages) });
    }
  }
  return out;
}

/** The command words of a shell segment, quotes removed. */
function words(segment: string): string[] {
  return [...segment.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
}

const PIP_EXACT = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9,._-]*\])?==[A-Za-z0-9.+!_-]+$/;
const NPM_EXACT = /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+@v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * Every package a RUN command installs by name, with whether it names an exact version. Each segment between
 * &&, ||, ;, | and newlines is one command; leading NAME=value words and sudo are skipped.
 */
export function installs(run: string): { installer: string; pkg: string; pinned: boolean }[] {
  const out: { installer: string; pkg: string; pinned: boolean }[] = [];
  for (const segment of run.split(/&&|\|\||;|\||\n/)) {
    let w = words(segment);
    while (w.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!) || w[0] === "sudo")) w = w.slice(1);
    const cmd = (w[0] ?? "").split("/").at(-1)!;
    const args = (from: number) => w.slice(from).filter((a) => !a.startsWith("-"));
    const add = (installer: string, pkgs: string[], ok: (p: string) => boolean) => pkgs.forEach((pkg) => out.push({ installer, pkg, pinned: ok(pkg) }));
    const sub = (i: number) => args(i)[0];
    if ((cmd === "apt-get" || cmd === "apt") && sub(1) === "install") add(`${cmd} install`, args(1).slice(1), (p) => /^[^=]+=.+$/.test(p));
    else if (cmd === "apk" && sub(1) === "add") add("apk add", args(1).slice(1), (p) => /^[^=]+=.+$/.test(p));
    else if ((cmd === "pip" || cmd === "pip3") && sub(1) === "install") add(`${cmd} install`, args(1).slice(1), (p) => PIP_EXACT.test(p));
    else if (/^python[0-9.]*$/.test(cmd) && w[1] === "-m" && w[2] === "pip" && w[3] === "install") add("pip install", args(4), (p) => PIP_EXACT.test(p));
    else if (cmd === "uv" && w[1] === "pip" && w[2] === "install") add("uv pip install", args(3), (p) => PIP_EXACT.test(p));
    else if (cmd === "uv" && w[1] === "tool" && w[2] === "install") add("uv tool install", args(3), (p) => PIP_EXACT.test(p));
    else if (cmd === "uv" && w[1] === "python" && w[2] === "install") add("uv python install", args(3), (p) => /^\d+\.\d+\.\d+$/.test(p));
    else if (cmd === "npm" && ["install", "i", "add"].includes(sub(1) ?? "")) add(`npm ${sub(1)}`, args(1).slice(1), (p) => NPM_EXACT.test(p));
    else if ((cmd === "bun" || cmd === "pnpm" || cmd === "yarn") && sub(1) === "add") add(`${cmd} add`, args(1).slice(1), (p) => NPM_EXACT.test(p));
    else if (cmd === "go" && sub(1) === "install") add("go install", args(1).slice(1), (p) => /@v\d+\.\d+\.\d+/.test(p));
  }
  return out;
}

/** A shell that runs what it reads on stdin (`sh -c '…'` reads stdin as data, so it doesn't count), behind optional sudo or env. */
const STDIN_SHELL = String.raw`(?:sudo\s+(?:-\S+\s+)*)?(?:env\s+(?:-\S+\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*)?(?:\S*\/)?(?:ba|da|z|a|k)?sh(?=$|[\s;&|)'"])(?!\s+-c\b)`;
/** A download piped into such a shell, through any stages (`curl … | sh`, `wget -qO- … | gunzip | bash -s`). */
const PIPE_TO_SHELL = new RegExp(String.raw`\b(?:curl|wget)\b[^|;&\n]*(?:\|(?!\|)[^|;&\n]*)*?\|(?!\|)\s*${STDIN_SHELL}`);
/** A download run through command or process substitution: `sh -c "$(curl …)"`, `bash <(curl …)`, `eval "$(wget …)"`, `. <(curl …)`. */
const SUBSTITUTED_DOWNLOAD = /(?:(?:^|[\s;&|(/])(?:ba|da|z|a|k)?sh(?:\s+-\S+)*|\beval|\bsource|(?:^|[\s;&|(])\.)\s+["']?(?:\$\(|`|<\()\s*(?:curl|wget)\b/;

/** Whether a RUN command runs a script it downloads without checking it: whatever the URL serves that day is what gets installed. */
export function pipesDownloadIntoShell(command: string): boolean {
  // For the pipe, quoted words are emptied first, so a quoted URL's `&` or a quoted `|` doesn't split the pipeline.
  return PIPE_TO_SHELL.test(command.replace(/"[^"]*"|'[^']*'/g, '""')) || SUBSTITUTED_DOWNLOAD.test(command);
}

/** pins.versions */
export async function pinsVersions(run: AuditRun): Promise<CheckResult[]> {
  const id = "pins.versions";
  const root = run.ctx.root;
  const problems: string[] = [];

  const mise = Bun.TOML.parse(await readFile(join(root, "mise.toml"), "utf8")) as { tools?: Record<string, unknown> };
  const tools = Object.entries(mise.tools ?? {});
  for (const [tool, v] of tools) {
    const versions = (Array.isArray(v) ? v : [v]).map((x) => (typeof x === "string" ? x : typeof (x as { version?: unknown })?.version === "string" ? (x as { version: string }).version : JSON.stringify(x)));
    for (const version of versions) {
      if (!EXACT.test(version)) problems.push(`mise.toml: ${tool} = "${version}" is not an exact version (never latest, a range or a prefix)`);
    }
  }

  const services = await composeServices(root);
  const dockerfiles = new Set<string>();
  let images = 0;
  for (const [name, s] of Object.entries(services)) {
    const file = dockerfileOf(s);
    if (file !== undefined) {
      dockerfiles.add(file);
      if (s.pull_policy !== "build") problems.push(`${COMPOSE_FILE}: ${name} is built here but has no pull_policy: build, so a pull could replace it with a registry image of that name`);
    } else if (s.image === undefined) problems.push(`${COMPOSE_FILE}: ${name} has neither an image nor a build`);
    else {
      images++;
      if (!DIGEST.test(s.image)) problems.push(`${COMPOSE_FILE}: ${name}'s image ${s.image} is not pinned by digest`);
    }
  }

  let froms = 0;
  let packages = 0;
  for (const file of [...dockerfiles].sort()) {
    const text = await readFile(join(root, file), "utf8");
    for (const { kind, image, stages } of dockerfileImages(text)) {
      if (image.toLowerCase() === "scratch" || stages.has(image.toLowerCase()) || /^\d+$/.test(image)) continue;
      froms++;
      if (!DIGEST.test(image)) problems.push(`${file}: ${kind === "FROM" ? `FROM ${image}` : `COPY --from=${image}`} is not pinned by digest`);
    }
    for (const { op, args } of instructions(text)) {
      if (op !== "RUN") continue;
      let command = args;
      if (args.startsWith("[")) {
        try {
          command = (JSON.parse(args) as string[]).join(" ");
        } catch {}
      }
      for (const i of installs(command)) {
        packages++;
        if (!i.pinned) problems.push(`${file}: ${i.installer} ${i.pkg} has no version (install packages by name at an exact version)`);
      }
      if (pipesDownloadIntoShell(command)) {
        problems.push(`${file}: a RUN pipes a download into a shell (curl or wget into sh, bash or eval), which installs whatever the URL serves that day: download it to a file, check its SHA-256, then run it, or install a pinned package`);
      }
    }
  }

  if (problems.length > 0) return [result(id, "fail", `${problems.join("; ")}. Pin it exactly (docs/runbooks/stack.md#pinned-images for images, README for tools)`)];
  return [
    result(
      id,
      "pass",
      `${tools.length} mise tools, ${images} images, ${froms} FROM/COPY --from images and ${packages} installed package${packages === 1 ? "" : "s"} are pinned (exact versions, digests); ${dockerfiles.size} services are built here, never pulled`,
    ),
  ];
}
