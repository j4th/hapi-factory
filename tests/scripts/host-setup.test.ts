/**
 * scripts/host-setup.sh, checked statically: it is never run here (it creates a
 * user and needs root). `bash -n` parses it; shellcheck, pinned in mise.toml,
 * lints it (the test skips only where shellcheck isn't installed); the rest reads the text for
 * what the script must do, in the order it must do it. One function, the
 * root-equivalence check, is also run on its own, with a stub `id` and `sudo`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HAPI_BIN, HAPI_CHECKOUT, HAPI_MISE, HAPI_USER } from "../../src/stack/up";

const REPO = resolve(import.meta.dir, "../..");
const SCRIPT = join(REPO, "scripts", "host-setup.sh");
const text = readFileSync(SCRIPT, "utf8");
const lines = text.split("\n");
/** The line number of the first line matching `re` (code, not a comment). */
const at = (re: RegExp) => lines.findIndex((l) => !l.trimStart().startsWith("#") && re.test(l));

test("bash parses it (bash -n)", () => {
  const r = Bun.spawnSync(["bash", "-n", SCRIPT], { stderr: "pipe" });
  expect([r.exitCode, r.stderr.toString()]).toEqual([0, ""]);
});

/** A shellcheck that runs (a mise shim with no version set doesn't). */
const shellcheck = Bun.which("shellcheck") !== null && Bun.spawnSync(["shellcheck", "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

test.skipIf(!shellcheck)("shellcheck finds nothing (when shellcheck is on PATH)", () => {
  const r = Bun.spawnSync(["shellcheck", "-x", SCRIPT], { stdout: "pipe" });
  expect([r.exitCode, r.stdout.toString()]).toEqual([0, ""]);
});

test("strict mode, and it refuses to run without root before it changes anything", () => {
  expect(lines[0]).toBe("#!/usr/bin/env bash");
  expect(at(/^set -euo pipefail$/)).toBeGreaterThan(0);
  const rootCheck = at(/\[\[ "\$\(id -u\)" -eq 0 \]\] \|\| die /);
  expect(rootCheck).toBeGreaterThan(at(/^set -euo pipefail$/));
  // Every step runs from the calls at the bottom, after the root check.
  const firstCall = at(/^ensure_user$/);
  expect(firstCall).toBeGreaterThan(rootCheck);
  for (const step of ["ensure_subids", "ensure_packages", "ensure_linger", "ensure_rootless_docker", "ensure_mise", 'ensure_checkout "\\$source_arg"', "next_steps"]) {
    expect([step, at(new RegExp(`^${step}$`)) > firstCall]).toEqual([step, true]);
  }
});

test("idempotent: each step checks before it acts", () => {
  expect(text).toContain(`id -u "$HAPI_USER" >/dev/null 2>&1`);
  expect(text).toContain("systemctl --user is-active --quiet docker");
  // A re-run leaves hapi's docker context alone once it is rootless (stage b saw `docker context use` reprint it).
  // The calls start their line, where hapi-home.test.ts checks what reaches sudo -i.
  expect(text).toContain("if ! as_hapi docker context show 2>/dev/null | grep -qx rootless && as_hapi docker context inspect rootless >/dev/null 2>&1; then");
  expect(text).toContain(`as_hapi_sh '[ -d "$1/.git" ]' "$HAPI_CHECKOUT"`);
  expect(text).toMatch(/hapi_mise_version \| grep -q "\^\$MISE_VERSION "/);
  expect(text).toContain(`as_hapi_sh 'grep -qxF "$1" .bashrc 2>/dev/null || printf "%s\\n" "$1" >>.bashrc'`);
});

test("creates the hapi user with subordinate IDs wide enough for the Squid rock's uid 584792", () => {
  expect(text).toContain(`readonly HAPI_USER=${HAPI_USER}`);
  const count = Number(/readonly SUBID_COUNT=(\d+)/.exec(text)?.[1]);
  expect(count).toBeGreaterThan(584792);
  expect(text).toContain(`-K SUB_UID_COUNT="$SUBID_COUNT" -K SUB_GID_COUNT="$SUBID_COUNT"`);
});

/** A shell function of the script, `name() { ... }` to its closing brace at the start of a line. */
const fn = (name: string) => new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}$`, "m").exec(text)?.[0] ?? "";

test("refuses a hapi that can become root, on every run: one in a root-equivalent group, or with any sudo rule", () => {
  // docker is the rootful daemon; sudo, admin and wheel are sudo's usual groups; lxd and incus-admin run
  // privileged containers; libvirt starts VMs with any host disk; disk reads and writes raw block devices.
  const groups = /^readonly ROOT_GROUPS=\(([^)]*)\)$/m.exec(text)?.[1]?.split(" ");
  expect(groups?.sort()).toEqual(["admin", "disk", "docker", "incus-admin", "libvirt", "lxd", "sudo", "wheel"]);
  const check = fn("refuse_root_equivalent");
  expect(check).toContain(`id -nG "$HAPI_USER"`);
  // As root, sudo lists another user's rules; in the C locale, so its English messages are what's matched.
  expect(check).toContain(`$(LC_ALL=C sudo -n -l -U "$HAPI_USER" 2>&1)`);
  // A hapi made by an earlier run or by hand is checked too: the last thing ensure_user does.
  expect(fn("ensure_user").split("\n").at(-2)?.trim()).toBe("refuse_root_equivalent");
});

describe("refuse_root_equivalent, run here with a stub id and sudo", () => {
  const temps: string[] = [];
  afterAll(() => {
    for (const d of temps) rmSync(d, { recursive: true, force: true });
  });
  /** The check, with hapi in `groups` (or `id -nG hapi` failing, for null) and `sudo -n -l -U hapi` printing `rules`; its exit code and stderr. */
  const run = (groups: string | null, rules: string) => {
    const bin = mkdtempSync(join(tmpdir(), "hapi-host-setup-"));
    temps.push(bin);
    writeFileSync(join(bin, "groups.txt"), `${groups ?? ""}\n`);
    writeFileSync(join(bin, "rules.txt"), rules);
    const lookup = groups === null ? `echo "id: 'hapi': no such user" >&2\nexit 1` : `cat "${bin}/groups.txt"`;
    writeFileSync(join(bin, "id"), `#!/bin/sh\n[ "$*" = "-nG hapi" ] || exit 99\n${lookup}\n`);
    // Only the listing, and only in the C locale; it exits 1 as sudo does for a user with no rules.
    writeFileSync(join(bin, "sudo"), `#!/bin/sh\n[ "$*" = "-n -l -U hapi" ] && [ "$LC_ALL" = C ] || exit 99\ncat "${bin}/rules.txt"\ngrep -q 'may run' "${bin}/rules.txt"\n`);
    for (const f of ["id", "sudo"]) chmodSync(join(bin, f), 0o755);
    const script = ["set -euo pipefail", `readonly HAPI_USER=${HAPI_USER}`, /^readonly ROOT_GROUPS=.*$/m.exec(text)![0], fn("die"), fn("refuse_root_equivalent"), "refuse_root_equivalent"].join("\n");
    const r = Bun.spawnSync(["bash", "-c", script], { env: { PATH: `${bin}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, err: r.stderr.toString() };
  };
  const NONE = "User hapi is not allowed to run sudo on host.\n";

  test("passes a hapi with only its own group and no sudo rule", () => {
    expect(run("hapi", NONE)).toEqual({ code: 0, err: "" });
  });

  test("refuses each root-equivalent group, naming the groups and the command that removes hapi from them", () => {
    for (const g of ["docker", "sudo", "admin", "wheel", "lxd", "incus-admin", "libvirt", "disk"]) {
      const r = run(`hapi users ${g}`, NONE);
      expect([g, r.code]).toEqual([g, 1]);
      expect(r.err).toContain(`hapi is in ${g},`);
      expect(r.err).toContain(`gpasswd -d hapi ${g}`);
    }
    const two = run("hapi lxd docker", NONE);
    expect(two.err).toContain("hapi is in lxd docker,");
    expect(two.err).toContain("gpasswd -d hapi lxd && gpasswd -d hapi docker");
    expect(run("hapi dockers", NONE).code).toBe(0); // whole names only
  });

  test("refuses any sudo rule, naming it", () => {
    const rules = "Matching Defaults entries for hapi on host:\n    env_reset\n\nUser hapi may run the following commands on host:\n    (ALL) NOPASSWD: /usr/bin/apt-get\n";
    const r = run("hapi", rules);
    expect(r.code).toBe(1);
    expect(r.err).toContain("hapi has sudo rules");
    expect(r.err).toContain("(ALL) NOPASSWD: /usr/bin/apt-get");
    expect(r.err).toContain("visudo");
  });

  test("refuses when it can't read hapi's groups, rather than take a failed lookup for no groups", () => {
    const r = run(null, NONE);
    expect(r.code).toBe(1);
    expect(r.err).toContain("could not read hapi's groups");
  });

  test("refuses when it can't read sudo's answer, rather than guess", () => {
    const r = run("hapi", "sudo: unable to resolve host\n");
    expect(r.code).toBe(1);
    expect(r.err).toContain("could not read hapi's sudo rules");
  });
});

test("rootless Docker kept alive by lingering, and checked to be rootless", () => {
  expect(text).toContain(`loginctl enable-linger "$HAPI_USER"`);
  expect(text).toContain("as_hapi dockerd-rootless-setuptool.sh install");
  expect(text).toContain(`docker info --format '{{.SecurityOptions}}' | grep -q rootless`);
});

test("mise is the version mise.toml requires, downloaded over HTTPS and checked against a pinned SHA-256; nothing is piped to a shell", () => {
  const minVersion = /^min_version = "([^"]+)"/m.exec(readFileSync(join(REPO, "mise.toml"), "utf8"))![1];
  expect(text).toContain(`readonly MISE_VERSION=${minVersion}`);
  expect(text).toMatch(/readonly MISE_SHA256_X64=[0-9a-f]{64}$/m);
  expect(text).toMatch(/readonly MISE_SHA256_ARM64=[0-9a-f]{64}$/m);
  expect(text).toContain("sha256sum -c --quiet -");
  expect(text).toContain("--proto '=https'");
  expect(text).not.toMatch(/\|\s*(ba)?sh\b/);
});

test("hapi's checkout is ~/hapi-factory (where up re-execs), made by hapi: a URL cloned as hapi, a local path cloned by root into its own temp dir and unpacked by hapi", () => {
  expect(text).toContain(`readonly HAPI_CHECKOUT=${HAPI_CHECKOUT}`);
  // A local path: root clones it --no-local into a mktemp -d, and streams it to hapi's tar.
  expect(text).toContain(`checkout_tmp="$(mktemp -d)"`);
  expect(text).toContain(`git -c safe.directory='*' clone --no-local -- "$src" "$checkout_tmp/repo"`);
  expect(text).toContain(`tar -C "$checkout_tmp/repo" -cf - . | as_hapi_sh 'umask 022\nmkdir -- "$1" || exit 1\nif tar -C "$1" --no-same-owner -xf -; then exit 0; fi`);
  // A URL: hapi clones it, into a directory it has just made.
  expect(text).toContain(`mkdir -- "$1" || exit 1\nif git clone -- "$2" "$1"; then exit 0; fi`);
  // The temp dir goes however the script ends.
  expect(text).toContain(`[[ -z "$checkout_tmp" ]] || rm -rf -- "$checkout_tmp"`);
  expect(text).toContain("trap cleanup EXIT");
  // The default source is this checkout's origin remote: no account name in the script.
  expect(text).toContain("remote get-url origin");
});

test("mise reaches hapi on stdin: root verifies its own download, hapi writes a temp name, chmods it and renames it into place", () => {
  expect(text).toContain(`mise_tmp="$(mktemp)"`);
  expect(text).toContain(`tmp="$(mktemp .local/bin/.mise.XXXXXX)" || exit 1\nif cat >"$tmp" && chmod 0755 "$tmp" && mv -fT "$tmp" .local/bin/mise; then exit 0; fi`);
  expect(text).toContain(`exit 1' <"$mise_tmp"`);
  // Checked again, as hapi, after the install.
  expect(text.match(/hapi_mise_version \| grep -q "\^\$MISE_VERSION "/g)?.length).toBe(2);
  // Where `up`'s re-exec runs it by absolute path (reexecScript), with its directory on PATH.
  expect(text).toContain(`mv -fT "$tmp" ${HAPI_MISE}; then`);
  expect(text).toContain(`mkdir -p ${HAPI_BIN}`);
});

test("prints the next steps: the rootless check, mise trust and install as hapi with its XDG_RUNTIME_DIR, the secrets join and add-machine, then up", () => {
  const steps = text.slice(text.indexOf("next_steps() {"));
  for (const s of [
    "sudo -iu $HAPI_USER docker info --format '{{.SecurityOptions}}'",
    "export XDG_RUNTIME_DIR=/run/user/$uid",
    "mise trust && mise install && mise run setup",
    "scripts/copy-secrets-to-hapi.sh",
    "mise run secrets:join -- --store ~/.config/hapi/secrets.enc.yaml --name $HAPI_USER",
    "mise run secrets:add-machine -- --name $HAPI_USER --recipient <age1...>",
    "mise run secrets:check",
    "mise run up",
  ]) {
    expect([s, steps.includes(s)]).toEqual([s, true]);
  }
});
