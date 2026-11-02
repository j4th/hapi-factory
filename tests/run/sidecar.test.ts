/**
 * The smoke sidecar (src/run/sidecar.ts; design §3.3, H-192): its `docker run` argv, pure, and its data's export
 * from the run's commit, with real git: blob by blob, regular files only, capped by policy/sidecars.yaml's limits,
 * and nothing written unless the whole data dir passes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { loadPolicy } from "../../src/policy/load";
import type { Sidecar } from "../../src/policy/types";
import { runBytes } from "../../src/run/cli";
import { exportSidecarData, SIDECAR_DATA, sidecarArgs, sidecarName } from "../../src/run/sidecar";
import { SIDECAR_ALIAS } from "../../src/stack/env";
import { PROJECT_LABEL, runCommand } from "../../src/stack/up";
import { caught, cleanup, tempDir } from "../secrets/helpers";
import { REPO } from "../stack/helpers";

afterEach(cleanup);

const ID = "ab12cd34ef56";
const LIMITS = { pids: 128, memory_mb: 512, data_files: 256, data_mb: 16 };
const S: Sidecar = { image: `example/bun@sha256:${"a".repeat(64)}`, command: ["bun", "/data/server.ts"], port: 8080, limits: LIMITS };
const rec = (project = "hapi") => ({ runId: ID, container: `${project}-run-${ID}`, network: `${project}-run-${ID}` });

describe("sidecarArgs", () => {
  test("the sidecar's argv: its own name, the run's labels and org.hapi.kind=sidecar, the run's network as hapi-sidecar, read-only as 1001 with every capability dropped, its data read-only at /data and /data its working directory, the policy's image and command, no secret and no port", () => {
    const d = { project: "hapi", user: "hapi", env: {} };
    const N = `hapi-run-${ID}`;
    expect(SIDECAR_ALIAS).toBe("hapi-sidecar");
    expect(sidecarName(N)).toBe(`${N}-sidecar`);
    expect(sidecarArgs(d, rec(), S, "/state/runs/ab12cd34ef56/sidecar")).toEqual([
      "docker", "run", "-d", "--pull", "never", "--name", `${N}-sidecar`,
      "--label", `org.hapi.run=${ID}`, "--label", "org.hapi.project=hapi",
      "--label", "org.hapi.kind=sidecar",
      // m24: who started it and the dev bypass, as runArgs computes them, so runtime.dev-override holds it like any container.
      "--label", "org.hapi.started-by=hapi", "--label", "org.hapi.dev-override=0",
      // The image's Compose labels, blanked as a run's are: a sidecar is never a service of the Compose project hapi.
      "--label", "com.docker.compose.project=", "--label", "com.docker.compose.service=", "--label", "com.docker.compose.version=",
      "--network", N, "--network-alias", "hapi-sidecar",
      "--read-only", "--user", "1001:1001", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "128", "--memory", "512m",
      "--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=3",
      "--tmpfs", "/tmp:size=64m,uid=1001,gid=1001,mode=0700", "-v", "/state/runs/ab12cd34ef56/sidecar:/data:ro", "-w", "/data", "-e", "HOME=/tmp", "-e", "PORT=8080",
      "--entrypoint", "bun", S.image, "/data/server.ts",
    ]);
  });

  test("its limits are the policy's, a test project's run gets org.hapi.int, the dev bypass is labelled, and a data dir a -v can't hold is refused", () => {
    const project = "hapi-int-ab12cd34";
    const argv = sidecarArgs({ project, user: "dev", env: { HAPI_ALLOW_CURRENT_USER: "1" } }, rec(project), { ...S, command: ["bun"], limits: { ...LIMITS, pids: 64, memory_mb: 256 } }, "/d");
    const after = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect([after("--pids-limit"), after("--memory")]).toEqual(["64", "256m"]);
    expect(argv.slice(7, 15)).toEqual(["--label", `org.hapi.run=${ID}`, "--label", `${PROJECT_LABEL}=${project}`, "--label", `org.hapi.int=${project}`, "--label", "org.hapi.kind=sidecar"]);
    expect(argv).toContain("org.hapi.started-by=dev");
    expect(argv).toContain("org.hapi.dev-override=1");
    // A one-word command: its entrypoint, then nothing after the image.
    expect(argv.slice(-3)).toEqual(["--entrypoint", "bun", S.image]);
    expect(argv.filter((a, i) => argv[i - 1] === "-e" && !a.includes("="))).toEqual([]);
    expect(argv.some((a) => ["-p", "--publish", "-P", "--publish-all"].includes(a))).toBe(false);
    expect(() => sidecarArgs({ project: "hapi", user: "hapi", env: {} }, rec(), S, "/state/a:b")).toThrow('cannot mount /state/a:b into the sidecar: its path holds ":" or ","');
  });

  test("the policy's bun-http sidecar is the pinned image, and its limits are policy/sidecars.yaml's fail-closed defaults", () => {
    const p = loadPolicy(join(REPO, "policy"));
    const s = p.sidecars["bun-http"]!;
    expect(s.limits).toEqual(LIMITS);
    const argv = sidecarArgs({ project: "hapi", user: "hapi", env: {} }, rec(), s, "/d");
    expect(argv.slice(-3)).toEqual(["bun", s.image, "/data/server.ts"]);
    expect(SIDECAR_DATA).toBe("sidecar");
  });
});

describe("exportSidecarData, with real git", () => {
  /** A bare repo whose one commit holds `files` (path to text), `links` (path to target) and `gitlinks` (paths of submodule entries). */
  async function repoWith(files: Record<string, string | Uint8Array>, o: { links?: Record<string, string>; gitlinks?: string[]; mode755?: string[] } = {}) {
    const tmp = tempDir("hapi-sidecar-");
    const work = join(tmp, "work");
    mkdirSync(work);
    const git = async (args: string[], cwd = work) => {
      const r = await runCommand(["git", "-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "commit.gpgSign=false", ...args], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmp, GIT_CONFIG_NOSYSTEM: "1" }, inherit: false });
      if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
      return r.stdout.trim();
    };
    await git(["-C", work, "init", "-q", "-b", "main"]);
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(join(work, p, ".."), { recursive: true });
      writeFileSync(join(work, p), text, { mode: o.mode755?.includes(p) ? 0o755 : 0o644 });
    }
    for (const [p, target] of Object.entries(o.links ?? {})) {
      mkdirSync(join(work, p, ".."), { recursive: true });
      symlinkSync(target, join(work, p));
    }
    await git(["-C", work, "add", "-A"]);
    for (const p of o.gitlinks ?? []) await git(["-C", work, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},${p}`]);
    await git(["-C", work, "commit", "-q", "-m", "one"]);
    const sha = await git(["-C", work, "rev-parse", "HEAD"]);
    const bare = join(tmp, "repo.git");
    await git(["clone", "-q", "--bare", work, bare]);
    // The run's record dir, which start has made by then (0700, hapi's).
    mkdirSync(join(tmp, "record"), { mode: 0o700 });
    return { tmp, bare, sha, dest: join(tmp, "record", "sidecar") };
  }
  const d = { run: runCommand, runBytes, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } };
  /** Every path under `dir`, relative, with its mode. */
  const listing = (dir: string) => {
    const out: [string, string][] = [];
    const walk = (p: string) => {
      for (const e of readdirSync(p, { withFileTypes: true })) {
        const full = join(p, e.name);
        out.push([relative(dir, full), (statSync(full).mode & 0o777).toString(8)]);
        if (e.isDirectory()) walk(full);
      }
    };
    walk(dir);
    return out.sort();
  };

  test("with real git: the data dir is exported at the run's commit as 0755 dirs and 0644 files, byte for byte, and nothing else of the tree", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 10, 13]);
    const r = await repoWith(
      { "smoke/server.ts": "Bun.serve({ fetch: () => new Response('ok') });\n", "smoke/data/fortunes.json": '["a"]\n', "smoke/bin.dat": bytes, "smoke/run.sh": "#!/bin/sh\n", "README.md": "not data\n", "smokey/x": "not data either\n" },
      { mode755: ["smoke/run.sh"] },
    );
    await exportSidecarData(d, r.bare, r.sha, "smoke", r.dest, LIMITS);
    expect(listing(r.dest)).toEqual([
      ["bin.dat", "644"],
      ["data", "755"],
      ["data/fortunes.json", "644"],
      // An executable blob is exported as data too: 0644, never run from the host.
      ["run.sh", "644"],
      ["server.ts", "644"],
    ]);
    expect((statSync(r.dest).mode & 0o777).toString(8)).toBe("755");
    expect(readFileSync(join(r.dest, "server.ts"), "utf8")).toBe("Bun.serve({ fetch: () => new Response('ok') });\n");
    expect(new Uint8Array(readFileSync(join(r.dest, "bin.dat")))).toEqual(bytes);
    // A nested data dir works the same way.
    const n = await repoWith({ "test/smoke/a.txt": "a\n", "test/b.txt": "b\n" });
    await exportSidecarData(d, n.bare, n.sha, "test/smoke", n.dest, LIMITS);
    expect(listing(n.dest)).toEqual([["a.txt", "644"]]);
  });

  test("with real git: a symlink or a submodule in the data dir, a data dir with no file, more than 256 files or more than 16 MiB is refused, and nothing is written", async () => {
    const cases: [what: string, make: () => ReturnType<typeof repoWith>, message: (sha: string) => string][] = [
      ["a symlink", () => repoWith({ "smoke/a.txt": "a\n", "other/secret": "x\n" }, { links: { "smoke/link": "../other/secret" } }), () => "smoke/link: a symlink in the sidecar's data dir; only regular files are exported"],
      ["a submodule", () => repoWith({ "smoke/a.txt": "a\n" }, { gitlinks: ["smoke/mod"] }), () => "smoke/mod: a submodule in the sidecar's data dir; only regular files are exported"],
      ["no data dir", () => repoWith({ "README.md": "x\n" }), (sha) => `smoke holds no file at ${sha}`],
      // The data dir itself a symlink: git lists nothing under it, so it holds no file.
      ["a data dir that is a symlink", () => repoWith({ "other/a.txt": "a\n" }, { links: { smoke: "other" } }), (sha) => `smoke holds no file at ${sha}`],
      [
        "257 files",
        () => repoWith(Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`smoke/f${i}.txt`, `${i}\n`]))),
        () => "smoke holds more than 256 files or 16 MiB: the sidecar's data is at most that",
      ],
      ["16 MiB and a byte", () => repoWith({ "smoke/big.bin": new Uint8Array(16 * 1024 * 1024 + 1) }), () => "smoke holds more than 256 files or 16 MiB: the sidecar's data is at most that"],
      ["16 MiB over two files", () => repoWith({ "smoke/a.bin": new Uint8Array(8 * 1024 * 1024), "smoke/b.bin": new Uint8Array(8 * 1024 * 1024 + 1) }), () => "smoke holds more than 256 files or 16 MiB: the sidecar's data is at most that"],
    ];
    for (const [what, make, message] of cases) {
      const r = await make();
      const e = await caught(exportSidecarData(d, r.bare, r.sha, "smoke", r.dest, LIMITS));
      expect([what, e.message]).toEqual([what, message(r.sha)]);
      expect([what, existsSync(r.dest)]).toEqual([what, false]);
    }
    // Exactly at the caps passes; the caps are the limits given (policy/sidecars.yaml's), not constants.
    const at = await repoWith(Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`smoke/f${i}.txt`, `${i}\n`])));
    await exportSidecarData(d, at.bare, at.sha, "smoke", at.dest, { data_files: 4, data_mb: 1 });
    expect(readdirSync(at.dest).length).toBe(4);
    const over = await repoWith(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`smoke/f${i}.txt`, `${i}\n`])));
    expect((await caught(exportSidecarData(d, over.bare, over.sha, "smoke", over.dest, { data_files: 4, data_mb: 1 }))).message).toBe("smoke holds more than 4 files or 1 MiB: the sidecar's data is at most that");
  });

  test("with real git: the data dir is a literal path, never a pathspec, and git reads the source with no config of its own", async () => {
    const r = await repoWith({ "smoke/a.txt": "a\n", "smoky/b.txt": "b\n" });
    // A glob character in the data dir matches nothing: `smok?` is not `smoke` or `smoky`.
    expect((await caught(exportSidecarData(d, r.bare, r.sha, "smok?", r.dest, LIMITS))).message).toBe(`smok? holds no file at ${r.sha}`);
    const calls: string[][] = [];
    const recorded = { ...d, run: (cmd: string[], o: Parameters<typeof runCommand>[1]) => (calls.push(cmd), runCommand(cmd, o)), runBytes: (cmd: string[], env: Record<string, string>) => (calls.push(cmd), runBytes(cmd, env)) };
    await exportSidecarData(recorded, r.bare, r.sha, "smoke", r.dest, LIMITS);
    expect(calls[0]).toEqual([
      "env", "-i", `PATH=${d.env.PATH}`, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "git", "--literal-pathspecs", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
      "-c", `safe.directory=${r.bare}`, "--git-dir", r.bare, "ls-tree", "-r", "-z", "-l", "--full-tree", r.sha, "--", "smoke/",
    ]);
    expect(calls[1]!.slice(-3)).toEqual(["cat-file", "blob", expect.stringMatching(/^[0-9a-f]{40}$/)]);
    expect(calls).toHaveLength(2);
  });
});
