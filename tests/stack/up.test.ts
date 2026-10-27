/**
 * `hapi stack up` and `hapi stack down` (src/stack/up.ts), with every command
 * they would run recorded instead: no Docker, sudo or real secret. The order
 * is the contract: policy build, then secrets, then Compose, and nothing is
 * started if an earlier step fails.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SecretError } from "../../src/secrets/provider";
import { secretsResolve } from "../../src/secrets/cli";
import { resolveAgeDir } from "../../src/secrets/providers/sops";
import { buildDigest, currentUserOverride, networkProblems, reexecScript, type StackDeps, stackDown, stackUp } from "../../src/stack/up";
import { capture, caught, cleanup, fullStore, sopsConfig, sopsStore, tempDir } from "../secrets/helpers";

afterEach(cleanup);

type Call = { cmd: string[]; env: Record<string, string>; inherit: boolean };

/** A private, internal zone network, as `docker network inspect` prints it. */
const net = (name: string, subnet = "172.20.0.0/16", internal = true) => ({ Name: name, Internal: internal, IPAM: { Config: [{ Subnet: subnet }] } });
const GOOD = [net("hapi_hermes-net"), net("hapi_archon-net", "172.21.0.0/16"), net("hapi_research-net", "192.168.16.0/20"), net("hapi_outbound", "172.23.0.0/16", false)];

/** Fakes for every step; `steps` records the order. */
function fakes(
  o: {
    user?: string;
    env?: Record<string, string>;
    networks?: unknown[];
    /** What `docker network inspect` returns instead of `networks` as JSON. */
    inspect?: { code: number; stdout: string; stderr?: string };
    downCode?: number;
    upCode?: number;
    resolve?: StackDeps["resolve"];
    build?: StackDeps["build"];
  } = {},
) {
  const steps: string[] = [];
  const calls: Call[] = [];
  const built = join(tempDir("hapi-stack-up-"), "config.yaml");
  writeFileSync(built, "fake: generated\n");
  const deps: StackDeps = {
    user: o.user ?? "hapi",
    env: o.env ?? { HOME: "/home/hapi", XDG_RUNTIME_DIR: "/run/user/1001", PATH: "/usr/bin" },
    build: o.build ?? (async (roster) => (steps.push(`build ${roster}`), [built])),
    resolve: o.resolve ?? (async (args) => (steps.push(`resolve ${args.join(" ")}`.trim()), 0)),
    run: async (cmd, opts) => {
      calls.push({ cmd, env: opts.env, inherit: opts.inherit });
      steps.push(cmd.slice(0, 2).join(" ") === "docker network" ? "docker network inspect" : cmd.join(" "));
      if (cmd[1] === "network") return o.inspect ?? { code: 0, stdout: JSON.stringify(o.networks ?? GOOD), stderr: "" };
      if (cmd.includes("--wait")) return { code: o.upCode ?? 0, stdout: "" };
      if (cmd.at(-1) === "down") return { code: o.downCode ?? 0, stdout: "" };
      return { code: 0, stdout: "" };
    },
  };
  return { deps, steps, calls };
}

const COMPOSE = ["docker", "compose", "-f", "stack/compose.yaml", "-p", "hapi"];

/** The whole script the re-exec hands `sh -c` as hapi, for `up`: fixed text, no argument in it. */
const UP_SCRIPT = `: "\${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; export XDG_RUNTIME_DIR; export PATH="$HOME/.local/bin:$PATH"; cd "$HOME/hapi-factory" && exec "$HOME/.local/bin/mise" run up -- "$@"`;

/** A config path no shell may parse: a parameter, a command substitution, backticks, both quotes, spaces and a newline. */
const HOSTILE = "/srv/a$b ${HOME} $(touch x) `touch y` it's \"q\" two  spaces\nline2.yaml";

/** A temp home laid out as hapi's: ~/hapi-factory, and a stand-in ~/.local/bin/mise that records its argv (NUL-separated), cwd, XDG_RUNTIME_DIR and PATH. */
function fakeHapiHome(): string {
  const home = tempDir("hapi-stack-reexec-");
  mkdirSync(join(home, "hapi-factory"));
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  const mise = join(home, ".local/bin/mise");
  writeFileSync(
    mise,
    '#!/bin/sh\nprintf \'%s\\0\' "$@" >"$HOME/seen.argv"\nprintf \'%s\\n\' "$PWD" "$XDG_RUNTIME_DIR" "$PATH" >"$HOME/seen"\n',
  );
  chmodSync(mise, 0o755);
  return home;
}

/** What the stand-in mise recorded. */
function readFakeMise(home: string) {
  const [pwd, xdg, path] = readFileSync(join(home, "seen"), "utf8").split("\n");
  return { argv: readFileSync(join(home, "seen.argv"), "utf8").split("\0").slice(0, -1), pwd: pwd!, xdg: xdg!, path: path! };
}

describe("currentUserOverride (the dev bypass, for Task 6's audit)", () => {
  test("the hapi user runs the stack itself; anyone else re-execs as hapi unless HAPI_ALLOW_CURRENT_USER=1", () => {
    expect(currentUserOverride({}, "hapi")).toEqual({ user: "hapi", isHapi: true, override: false });
    expect(currentUserOverride({ HAPI_ALLOW_CURRENT_USER: "1" }, "hapi")).toEqual({ user: "hapi", isHapi: true, override: false });
    expect(currentUserOverride({}, "dev")).toEqual({ user: "dev", isHapi: false, override: false });
    expect(currentUserOverride({ HAPI_ALLOW_CURRENT_USER: "1" }, "dev")).toEqual({ user: "dev", isHapi: false, override: true });
    // Only exactly "1" turns it on.
    for (const v of ["", "0", "true", "yes", " 1"]) expect(currentUserOverride({ HAPI_ALLOW_CURRENT_USER: v }, "dev").override).toBe(false);
  });

  test("$USER is not trusted: the user is the one the process runs as", () => {
    // A spoofed USER=hapi doesn't make another user the hapi user.
    expect(currentUserOverride({ USER: "hapi" }, "dev").isHapi).toBe(false);
  });
});

describe("hapi stack up", () => {
  test("as hapi: policy build, secrets, then compose create, the network check, and compose up --wait, in that order", async () => {
    capture();
    const f = fakes();
    expect(await stackUp(["--roster", "budget"], f.deps)).toBe(0);
    expect(f.steps).toEqual([
      "build budget",
      "resolve",
      [...COMPOSE, "up", "--no-start", "--build"].join(" "),
      "docker network inspect",
      [...COMPOSE, "up", "-d", "--wait", "--wait-timeout", "300"].join(" "),
    ]);
    const inspect = f.calls.find((c) => c.cmd[1] === "network")!;
    expect(inspect.cmd.slice(3)).toEqual(["hapi_hermes-net", "hapi_archon-net", "hapi_research-net"]);
    // Compose gets the caller's env (XDG_RUNTIME_DIR for the env files) and the labels' values.
    const up = f.calls.at(-1)!;
    expect(up.inherit).toBe(true);
    expect(up.env).toMatchObject({ XDG_RUNTIME_DIR: "/run/user/1001", HAPI_STARTED_BY: "hapi", HAPI_DEV_OVERRIDE: "0" });
    // The build's digest labels every container, so a changed generated file recreates them.
    expect(up.env.HAPI_BUILD_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(f.calls.every((c) => c.cmd[0] !== "docker" || c.cmd[1] !== "compose" || c.env.HAPI_BUILD_SHA256 === up.env.HAPI_BUILD_SHA256)).toBe(true);
  });

  test("buildDigest covers each generated file's path and contents, in any order", () => {
    const dir = tempDir("hapi-stack-digest-");
    const a = join(dir, "a.conf");
    const b = join(dir, "b.conf");
    writeFileSync(a, "one");
    writeFileSync(b, "two");
    const d = buildDigest([a, b]);
    expect(buildDigest([b, a])).toBe(d);
    writeFileSync(b, "two, edited");
    expect(buildDigest([a, b])).not.toBe(d);
    expect(buildDigest([a])).not.toBe(buildDigest([b]));
  });

  test("--config reaches the secrets step; the default roster is anthropic", async () => {
    capture();
    const f = fakes();
    expect(await stackUp(["--config", "/home/hapi/.config/hapi/other.yaml"], f.deps)).toBe(0);
    expect(f.steps.slice(0, 2)).toEqual(["build anthropic", "resolve --config /home/hapi/.config/hapi/other.yaml"]);
  });

  test("as another user: re-execs `mise run up` as hapi through sudo -u hapi -H (never -i), in hapi's checkout, with hapi's XDG_RUNTIME_DIR and mise", async () => {
    const { err } = capture();
    const f = fakes({ user: "dev" });
    expect(await stackUp(["--roster", "budget", "--config", "/srv/it's.yaml"], f.deps)).toBe(0);
    expect(f.steps).toHaveLength(1);
    const [sudo] = f.calls;
    expect(sudo!.cmd).toEqual(["sudo", "-u", "hapi", "-H", "--", "sh", "-c", UP_SCRIPT, "hapi-stack", "--roster", "budget", "--config", "/srv/it's.yaml"]);
    expect(reexecScript("up")).toBe(UP_SCRIPT);
    expect(sudo!.inherit).toBe(true);
    expect(err.join("\n")).toContain("running as hapi (sudo -u hapi -H), not dev");
    expect(err.join("\n")).toContain("HAPI_ALLOW_CURRENT_USER=1");
  });

  test("the re-exec never hands sudo a login shell (-i) or a shell (-s), and its script holds none of the forwarded arguments (H-148)", async () => {
    capture();
    const scripts = new Set<string>();
    for (const args of [[], ["--roster", "budget"], ["--config", HOSTILE], ["--roster", "portable", "--config", "/srv/x.yaml"]]) {
      const f = fakes({ user: "dev" });
      await stackUp(args, f.deps);
      const cmd = f.calls[0]!.cmd;
      // sudo's own options are everything before its "--": exactly -u hapi -H.
      expect(cmd.slice(0, cmd.indexOf("--"))).toEqual(["sudo", "-u", "hapi", "-H"]);
      // The script is fixed text, the same whatever the arguments, and none of them is in it.
      const script = cmd[7]!;
      scripts.add(script);
      for (const a of args) expect([a, script.includes(a)]).toEqual([a, false]);
      expect(cmd.slice(8)).toEqual(["hapi-stack", ...args]);
    }
    expect([...scripts]).toEqual([UP_SCRIPT]);
  });

  test("run as sh would run it, the re-exec delivers `$b`, `$(touch x)`, backticks, quotes, spaces and newlines to mise verbatim, one argv entry each, expanding nothing", async () => {
    capture();
    const f = fakes({ user: "dev" });
    // The config path is the only free-form argument up takes; parseUp accepts any value that doesn't start with "-".
    const args = ["--config", HOSTILE];
    await stackUp(args, f.deps);
    const cmd = f.calls[0]!.cmd;
    // What sudo would exec as hapi: everything after its "--". HOME stands in for hapi's (sudo -H), with no XDG_RUNTIME_DIR (sudo clears it).
    const home = fakeHapiHome();
    const r = Bun.spawnSync(cmd.slice(cmd.indexOf("--") + 1), { cwd: home, env: { HOME: home, PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
    expect([r.exitCode, r.stderr.toString()]).toEqual([0, ""]);
    const seen = readFakeMise(home);
    expect(seen.argv).toEqual(["run", "up", "--", "--config", HOSTILE]);
    expect(seen.pwd).toBe(join(home, "hapi-factory"));
    expect(seen.xdg).toBe(`/run/user/${process.getuid!()}`);
    expect(seen.path.split(":")[0]).toBe(join(home, ".local/bin"));
    // Nothing in the argument ran: no file from $(touch x) or `touch y`, anywhere it could have landed.
    for (const dir of [home, join(home, "hapi-factory"), join(home, ".local/bin")]) {
      expect([dir, readdirSync(dir).filter((n) => n === "x" || n === "y")]).toEqual([dir, []]);
    }
  });

  test("the re-exec keeps an XDG_RUNTIME_DIR that sudo passes through (lingering), and passes down's empty argument list as nothing", async () => {
    capture();
    const f = fakes({ user: "dev" });
    await stackDown([], f.deps);
    const cmd = f.calls[0]!.cmd;
    const home = fakeHapiHome();
    const r = Bun.spawnSync(cmd.slice(cmd.indexOf("--") + 1), { cwd: home, env: { HOME: home, PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: "/run/user/4242" }, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    const seen = readFakeMise(home);
    expect(seen.argv).toEqual(["run", "down", "--"]);
    expect(seen.xdg).toBe("/run/user/4242");
  });

  test("the re-exec fails, running nothing, when hapi's checkout is missing", () => {
    const home = fakeHapiHome();
    rmSync(join(home, "hapi-factory"), { recursive: true });
    const r = Bun.spawnSync(["sh", "-c", UP_SCRIPT, "hapi-stack"], { cwd: home, env: { HOME: home, PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(join(home, "seen"))).toBe(false);
  });

  test("the re-exec's exit code is up's", async () => {
    capture();
    const f = fakes({ user: "dev" });
    f.deps.run = async () => ({ code: 7, stdout: "" });
    expect(await stackUp([], f.deps)).toBe(7);
  });

  test("HAPI_ALLOW_CURRENT_USER=1: runs as the current user, warns that it is a dev-only downgrade, and labels the stack", async () => {
    const { err } = capture();
    const f = fakes({ user: "dev", env: { HOME: "/home/dev", XDG_RUNTIME_DIR: "/run/user/1000", HAPI_ALLOW_CURRENT_USER: "1" } });
    expect(await stackUp([], f.deps)).toBe(0);
    expect(f.steps[0]).toBe("build anthropic");
    expect(f.calls.some((c) => c.cmd[0] === "sudo")).toBe(false);
    expect(err.join("\n")).toMatch(/warning: HAPI_ALLOW_CURRENT_USER=1: running the stack as dev, not hapi: a dev-only downgrade/);
    expect(f.calls.at(-1)!.env).toMatchObject({ HAPI_STARTED_BY: "dev", HAPI_DEV_OVERRIDE: "1" });
  });

  test("a secrets failure aborts with nothing started: no compose call at all", async () => {
    capture();
    const f = fakes({
      resolve: async () => {
        throw new SecretError("hermes/ANTHROPIC_API_KEY (hapi-hermes-anthropic-api-key) is not in the sops store: add it with `mise run secrets:edit`");
      },
    });
    const e = await caught(stackUp([], f.deps));
    expect(e.message).toContain("hermes/ANTHROPIC_API_KEY");
    expect(f.calls).toEqual([]);
  });

  test("a secrets step that returns non-zero (rather than throwing) aborts too", async () => {
    capture();
    const f = fakes({ resolve: async () => 2 });
    await expect(stackUp([], f.deps)).rejects.toThrow(/hapi secrets resolve exited 2; nothing was started/);
    expect(f.calls).toEqual([]);
  });

  test("a policy build failure aborts before secrets are read", async () => {
    capture();
    const f = fakes({
      build: async () => {
        throw new Error("policy/trusted_sources.yaml: /zones/archon/hosts/0: must match pattern");
      },
    });
    await expect(stackUp([], f.deps)).rejects.toThrow(/trusted_sources/);
    expect(f.steps).toEqual([]);
  });

  test("when `mise where age` fails, up fails with nothing started and names the fix (the real resolve path)", async () => {
    capture();
    const root = tempDir();
    const home = join(root, "home");
    const xdg = join(root, "run");
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(xdg, { mode: 0o700 });
    const store = sopsStore(root, fullStore());
    const config = sopsConfig(root, store);
    const env = { HOME: home, XDG_RUNTIME_DIR: xdg, PATH: "/usr/bin:/bin" };
    // What the sops provider sees when hapi's checkout isn't trusted or installed under mise.
    const ageDir = () =>
      resolveAgeDir({
        where: async () => {
          throw new SecretError("`mise where age` failed (exit 1): mise ERROR Config files in ~/hapi-factory/mise.toml are not trusted.: run `mise install` in the hapi-factory checkout");
        },
      });
    const f = fakes({ env, resolve: (args) => secretsResolve(args, { env, sops: store.run, ageDir }) });
    const e = await caught(stackUp(["--config", config], f.deps));
    expect(e.message).toMatch(/`mise where age` failed .*run `mise install` in the hapi-factory checkout/);
    expect(f.calls).toEqual([]);
    expect(store.calls).toEqual([]);
  });

  test("a zone network that isn't internal, or isn't private, stops the stack before anything starts", async () => {
    capture();
    for (const networks of [
      [net("hapi_hermes-net", "172.20.0.0/16", false), ...GOOD.slice(1)],
      [net("hapi_hermes-net", "100.64.0.0/24"), ...GOOD.slice(1)],
      GOOD.slice(1),
    ]) {
      const f = fakes({ networks });
      await expect(stackUp([], f.deps)).rejects.toThrow(/zone network/);
      // The created containers are removed again, and `up -d` never runs.
      expect(f.steps.at(-1)).toBe("docker compose -p hapi down");
      expect(f.steps.some((s) => s.includes("--wait"))).toBe(false);
    }
  });

  test("a failed `docker network inspect` names its exit code and stderr, and removes what was created", async () => {
    capture();
    const f = fakes({ inspect: { code: 1, stdout: "[]", stderr: "Error response from daemon: Cannot connect to the Docker daemon at unix:///run/user/1001/docker.sock\n" } });
    const e = await caught(stackUp([], f.deps));
    expect(e.message).toMatch(/^docker network inspect hapi_hermes-net hapi_archon-net hapi_research-net exited 1: Error response from daemon: Cannot connect to the Docker daemon/);
    // Not mistaken for a missing network.
    expect(e.message).not.toContain("does not exist");
    expect(e.message).toContain("Nothing was started, and what `compose up --no-start` created was removed");
    expect(f.steps.at(-1)).toBe("docker compose -p hapi down");
    expect(f.steps.some((s) => s.includes("--wait"))).toBe(false);
  });

  test("inspect output that isn't a JSON array of networks stops the stack too, and removes what was created", async () => {
    capture();
    for (const stdout of ["", "not json", "{}"]) {
      const f = fakes({ inspect: { code: 0, stdout, stderr: "" } });
      await expect(stackUp([], f.deps)).rejects.toThrow(/printed something that is not a JSON array of networks\. Nothing was started/);
      expect(f.steps.at(-1)).toBe("docker compose -p hapi down");
      expect(f.steps.some((s) => s.includes("--wait"))).toBe(false);
    }
  });

  test("a subnet the CIDR parser rejects throws inside the check, and still removes what was created", async () => {
    capture();
    const f = fakes({ networks: [net("hapi_hermes-net", "not-a-subnet"), ...GOOD.slice(1)] });
    const e = await caught(stackUp([], f.deps));
    expect(e.message).toContain('"not-a-subnet" is not an IP address or network');
    expect(f.steps.at(-1)).toBe("docker compose -p hapi down");
    expect(f.steps.some((s) => s.includes("--wait"))).toBe(false);
  });

  test("when removing what was created fails too, the error says so and how to finish", async () => {
    capture();
    const f = fakes({ networks: [net("hapi_hermes-net", "172.20.0.0/16", false), ...GOOD.slice(1)], downCode: 3 });
    await expect(stackUp([], f.deps)).rejects.toThrow(/not internal.*Nothing was started, but removing what `compose up --no-start` created failed \(docker compose -p hapi down exited 3\): run `mise run down`/);
  });

  test("a stack that doesn't come up healthy fails, and says where to look", async () => {
    capture();
    const f = fakes({ upCode: 1 });
    await expect(stackUp([], f.deps)).rejects.toThrow(/did not come up healthy.*docker compose -p hapi ps/);
  });

  test("usage errors exit 2 and run nothing", async () => {
    const { err } = capture();
    for (const args of [["--roster"], ["--roster", "nope"], ["--bogus"], ["stray"], ["--config", "-x"]]) {
      const f = fakes();
      expect(await stackUp(args, f.deps)).toBe(2);
      expect(f.steps).toEqual([]);
    }
    expect(err.join("\n")).toContain("usage: hapi stack up [--roster budget|anthropic|portable] [--config file]");
  });
});

describe("networkProblems", () => {
  test("none for internal zone networks inside the proxies' zone_clients ranges", () => {
    expect(networkProblems(GOOD, "hapi")).toEqual([]);
    expect(networkProblems([net("p_hermes-net", "10.1.0.0/24"), net("p_archon-net", "fd00:1::/64"), net("p_research-net", "192.168.0.0/24")], "p")).toEqual([]);
  });

  test("names each missing, non-internal or non-private zone network", () => {
    expect(networkProblems([net("hapi_hermes-net", "172.20.0.0/16", false), net("hapi_archon-net", "100.64.0.0/24")], "hapi")).toEqual([
      "zone network hapi_hermes-net is not internal: it would have a route out around the proxy",
      "zone network hapi_archon-net has subnet 100.64.0.0/24, outside the proxies' zone_clients ranges, so its requests would all be refused: set Docker's default-address-pools to private ranges",
      "zone network hapi_research-net does not exist",
    ]);
  });
});

describe("hapi stack down", () => {
  test("as hapi: compose down by project name, keeping the volumes, with no compose file or XDG_RUNTIME_DIR needed", async () => {
    capture();
    const f = fakes({ env: { HOME: "/home/hapi" } });
    expect(await stackDown([], f.deps)).toBe(0);
    expect(f.calls.map((c) => [c.cmd, c.inherit])).toEqual([[["docker", "compose", "-p", "hapi", "down"], true]]);
  });

  test("as another user: re-execs `mise run down` as hapi (the host admin's kill switch)", async () => {
    capture();
    const f = fakes({ user: "dev" });
    expect(await stackDown([], f.deps)).toBe(0);
    expect(f.calls[0]!.cmd).toEqual(["sudo", "-u", "hapi", "-H", "--", "sh", "-c", UP_SCRIPT.replace("run up --", "run down --"), "hapi-stack"]);
    expect(reexecScript("down")).toBe(UP_SCRIPT.replace("run up --", "run down --"));
  });

  test("down takes no arguments", async () => {
    capture();
    const f = fakes();
    expect(await stackDown(["-v"], f.deps)).toBe(2);
    expect(f.calls).toEqual([]);
  });
});
