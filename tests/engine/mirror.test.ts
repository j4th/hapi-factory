/**
 * The engine's mirrors (src/engine/mirror.ts, design §3.4): where they live, a credential-free bare repo per
 * registered repo, made world-readable for the run container's uid, and a fetch of only main and factory/* whose
 * token is in the fetch's environment alone, never its argv or the mirror's config, and redacted from its errors.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { engineDirOf, ensureMirror, fetchMirror, type MirrorDeps, mirrorPath } from "../../src/engine/mirror";
import { pinWorkOrder } from "../../src/engine/discover";
import { authedHostGit, hardenedGit } from "../../src/run/git";
import { runCommand, type Runner } from "../../src/stack/up";
import { caught, cleanup, tempDir } from "../secrets/helpers";
import { workRepo } from "./helpers";

afterEach(cleanup);

const REPO = "example-owner/example-repo";
const TOKEN = "fake-mirror-token";
const PATH = process.env.PATH ?? "/usr/bin:/bin";
const mode = (p: string) => statSync(p).mode & 0o777;

const ORIGIN_LINE = `remote.origin.url https://github.com/${REPO}.git\n`;

/** A Runner that records each call, answers a `git config` read with `config`, and any other call with `answer`. */
function fakeRunner(answer: { code: number; stdout?: string; stderr?: string } = { code: 0 }, config = ORIGIN_LINE) {
  const calls: { cmd: string[]; env: Record<string, string>; inherit: boolean }[] = [];
  const run: Runner = async (cmd, o) => {
    calls.push({ cmd, env: o.env, inherit: o.inherit });
    if (cmd.includes("config")) return { code: config === "" ? 1 : 0, stdout: config, stderr: "" };
    return { code: answer.code, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
  };
  return { run, calls };
}

/** A mirror's HEAD, so the fake's fetchMirror finds one. */
function fakeMirror(d: MirrorDeps): string {
  const m = mirrorPath(d.engineDir, REPO);
  mkdirSync(m, { recursive: true });
  writeFileSync(join(m, "HEAD"), "ref: refs/heads/main\n");
  return m;
}

/** Real git over a fresh engine dir. */
function realDeps(): MirrorDeps {
  return { run: runCommand, env: { PATH }, engineDir: join(tempDir("hapi-engine-"), "engine") };
}

/** Run git for a test's own reads, with no system or global config. */
function readGit(...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { env: { PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdout: "pipe", stderr: "pipe" });
  expect([args.join(" "), r.exitCode, r.stderr.toString()]).toEqual([args.join(" "), 0, expect.any(String)]);
  return r.stdout.toString();
}

test("engineDirOf and mirrorPath", () => {
  expect(engineDirOf({ HOME: "/h" })).toBe("/h/.local/state/hapi/engine");
  expect(engineDirOf({ HOME: "/h", XDG_STATE_HOME: "/s" })).toBe("/s/hapi/engine");
  expect(mirrorPath("/e", "example-owner/example-repo")).toBe("/e/mirrors/example-owner/example-repo.git");
  expect(() => mirrorPath("/e", "example-owner/..")).toThrow("not an owner/name: example-owner/..");
});

test("with real git: ensureMirror makes a world-readable bare repo whose config names only origin's URL", async () => {
  const d = realDeps();
  const m = await ensureMirror(d, REPO);
  expect(m).toBe(mirrorPath(d.engineDir, REPO));
  expect(mode(join(m, "HEAD"))).toBe(0o644);
  expect(mode(join(m, "objects"))).toBe(0o755);
  expect(mode(join(d.engineDir, "mirrors", "example-owner"))).toBe(0o700);
  const lines = readGit("config", "--file", join(m, "config"), "--list").trim().split("\n");
  expect(lines).toContain("core.sharedrepository=0644");
  expect(lines).toContain("core.bare=true");
  // --shared sets it: a forced push into the mirror is refused (the poller only ever fetches into it).
  expect(lines).toContain("receive.denynonfastforwards=true");
  expect(lines.filter((l) => l.startsWith("remote."))).toEqual(["remote.origin.url=https://github.com/example-owner/example-repo.git"]);
  expect(lines.filter((l) => /extraheader|fetch|pushurl|credential/i.test(l))).toEqual([]);

  const config = readFileSync(join(m, "config"));
  expect(await ensureMirror(d, REPO)).toBe(m);
  expect(readFileSync(join(m, "config")).equals(config)).toBe(true);

  readGit("--git-dir", m, "config", "remote.origin.url", "https://example.invalid/other.git");
  expect((await caught(ensureMirror(d, REPO))).message).toBe(
    `${m}'s origin is https://example.invalid/other.git, not https://github.com/example-owner/example-repo.git: remove the mirror; the next tick makes it again`,
  );
});

test("with real git: a half-made mirror is finished, and any other remote setting is refused", async () => {
  const d = realDeps();
  const m = mirrorPath(d.engineDir, REPO);
  const origin = `https://github.com/${REPO}.git`;
  const remotes = () => readGit("config", "--file", join(m, "config"), "--list").trim().split("\n").filter((l) => l.startsWith("remote."));
  // An init that ran before its origin was set: HEAD, and no remote.* at all.
  mkdirSync(join(d.engineDir, "mirrors", "example-owner"), { recursive: true, mode: 0o700 });
  readGit("init", "--bare", "--quiet", "--shared=0644", "--initial-branch=main", m);
  expect(remotes()).toEqual([]);
  expect(await ensureMirror(d, REPO)).toBe(m);
  expect(remotes()).toEqual([`remote.origin.url=${origin}`]);

  readGit("--git-dir", m, "config", "remote.origin.fetch", "+refs/*:refs/*");
  expect((await caught(ensureMirror(d, REPO))).message).toBe(`${m}'s config has remote settings besides origin's URL (remote.origin.fetch): remove the mirror; the next tick makes it again`);
  readGit("--git-dir", m, "config", "--unset", "remote.origin.fetch");
  readGit("--git-dir", m, "config", "--add", "remote.origin.url", "https://example.invalid/second.git");
  expect((await caught(ensureMirror(d, REPO))).message).toBe(`${m}'s origin is ${origin} and https://example.invalid/second.git, not ${origin}: remove the mirror; the next tick makes it again`);
  readGit("--git-dir", m, "config", "--unset-all", "remote.origin.url");
  readGit("--git-dir", m, "config", "remote.other.url", origin);
  // No origin, but another remote: not half-made, so not repaired.
  expect((await caught(ensureMirror(d, REPO))).message).toBe(`${m}'s origin is unset, not ${origin}: remove the mirror; the next tick makes it again`);
  expect(remotes()).toEqual([`remote.other.url=${origin}`]);
});

test("with real git: a fetch brings only main and factory/*, prunes, and leaves the mirror's config as it was", async () => {
  const tmp = tempDir("hapi-engine-");
  mkdirSync(join(tmp, "work"));
  const git = workRepo(join(tmp, "work"));
  git("branch", "factory/0001-one");
  git("branch", "factory/0002-two");
  git("branch", "other");
  git("tag", "v1");
  // The fetch's own argv and env, with one more env-only config entry that sends origin's URL to the work repo,
  // so a real fetch runs with no network. Only that entry, and the file protocol it needs, are added.
  const run: Runner = (cmd, o) =>
    runCommand(cmd, { ...o, env: { ...o.env, GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_1: `url.${git.dir}.insteadOf`, GIT_CONFIG_VALUE_1: `https://github.com/${REPO}.git`, GIT_ALLOW_PROTOCOL: "file" } });
  const d: MirrorDeps = { run, env: { PATH }, engineDir: join(tmp, "engine") };
  const m = await ensureMirror(d, REPO);
  const config = readFileSync(join(m, "config"));
  const refs = () => readGit("--git-dir", m, "for-each-ref", "--format=%(refname)").trim().split("\n");

  await fetchMirror(d, REPO, TOKEN);
  expect(refs()).toEqual(["refs/heads/factory/0001-one", "refs/heads/factory/0002-two", "refs/heads/main"]);
  expect(readGit("--git-dir", m, "rev-parse", "refs/heads/main").trim()).toBe(git("rev-parse", "main"));
  expect(readFileSync(join(m, "config")).equals(config)).toBe(true);
  expect(existsSync(join(m, "FETCH_HEAD"))).toBe(false);
  const all = (dir: string): string[] => readdirSync(dir).flatMap((n) => (lstatSync(join(dir, n)).isDirectory() ? [join(dir, n), ...all(join(dir, n))] : [join(dir, n)]));
  for (const p of all(m)) {
    const bits = lstatSync(p).isDirectory() ? 0o005 : 0o004;
    expect([p, statSync(p).mode & bits]).toEqual([p, bits]);
  }
  // No file the fetch wrote or touched holds the token or its header (objects are compressed: this is for the rest).
  for (const p of all(m).filter((x) => lstatSync(x).isFile())) {
    const text = readFileSync(p, "latin1");
    expect([p, text.includes(TOKEN) || text.includes(btoa(`x-access-token:${TOKEN}`))]).toEqual([p, false]);
  }

  // The prune touches only main and factory/*: a pin stays.
  await pinWorkOrder(d, REPO, "0001-one", git("rev-parse", "main"));
  git("branch", "-D", "factory/0002-two");
  await fetchMirror(d, REPO, TOKEN);
  expect(refs()).toEqual(["refs/hapi/orders/0001-one", "refs/heads/factory/0001-one", "refs/heads/main"]);
});

test("fetchMirror fetches only main and factory/*, with the token in the env and never in argv", async () => {
  const f = fakeRunner();
  const d: MirrorDeps = { run: f.run, env: { PATH: "/usr/bin:/bin", HOME: "/h" }, engineDir: join(tempDir("hapi-engine-"), "engine") };
  const m = mirrorPath(d.engineDir, REPO);

  expect((await caught(fetchMirror(d, REPO, TOKEN))).message).toBe(`no mirror at ${m}: ensureMirror first`);
  expect(f.calls).toEqual([]);

  fakeMirror(d);
  await fetchMirror(d, REPO, TOKEN);
  const authed = authedHostGit(d, TOKEN, { git: ["--git-dir", m] });
  const plain = hardenedGit(d, { git: ["--git-dir", m] });
  expect(f.calls).toEqual([
    // The origin is checked first, by hardened git with no token.
    { cmd: [...plain.cmd, "config", "--get-regexp", "^remote\\."], env: { PATH: "/usr/bin:/bin" }, inherit: false },
    {
      cmd: [...authed.cmd, "fetch", "--quiet", "--prune", "--no-tags", "--no-write-fetch-head", "origin", "+refs/heads/main:refs/heads/main", "+refs/heads/factory/*:refs/heads/factory/*"],
      env: authed.env,
      inherit: false,
    },
  ]);
  const argv = f.calls[1]!.cmd.join(" ");
  expect(argv).not.toContain(TOKEN);
  expect(argv).not.toContain(btoa(`x-access-token:${TOKEN}`));
  expect(f.calls[1]!.env.HOME).toBeUndefined();
});

test("fetchMirror refuses a mirror whose origin isn't the repo's, before any fetch", async () => {
  for (const [config, why] of [
    ["remote.origin.url https://example.invalid/other.git\n", "origin is https://example.invalid/other.git"],
    ["", "origin is unset"],
    [`${ORIGIN_LINE}remote.origin.pushurl https://example.invalid/x.git\n`, "config has remote settings besides origin's URL (remote.origin.pushurl)"],
  ] as const) {
    const f = fakeRunner({ code: 0 }, config);
    const d: MirrorDeps = { run: f.run, env: { PATH: "/usr/bin:/bin" }, engineDir: join(tempDir("hapi-engine-"), "engine") };
    const m = fakeMirror(d);
    const e = await caught(fetchMirror(d, REPO, TOKEN));
    expect(e.message.startsWith(`${m}'s ${why}`)).toBe(true);
    expect(e.message.endsWith(": remove the mirror; the next tick makes it again")).toBe(true);
    expect(f.calls.filter((c) => c.cmd.includes("fetch"))).toEqual([]);
  }
});

test("a failed fetch throws with the token and its header redacted", async () => {
  const header = `AUTHORIZATION: basic ${btoa(`x-access-token:${TOKEN}`)}`;
  const f = fakeRunner({ code: 128, stderr: `fatal: unable to access with ${TOKEN} and ${header}\nsecond line ${TOKEN}\n` });
  const d: MirrorDeps = { run: f.run, env: { PATH: "/usr/bin:/bin" }, engineDir: join(tempDir("hapi-engine-"), "engine") };
  fakeMirror(d);
  const e = await caught(fetchMirror(d, REPO, TOKEN));
  expect(e.message).toBe("cannot fetch example-owner/example-repo into its mirror (git fetch exited 128): fatal: unable to access with [redacted] and AUTHORIZATION: basic [redacted]");
  expect(e.message).not.toContain(TOKEN);
  expect(e.message).not.toContain(btoa(`x-access-token:${TOKEN}`));
});
