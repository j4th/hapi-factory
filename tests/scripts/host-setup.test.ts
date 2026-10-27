/**
 * scripts/host-setup.sh, checked statically: it is never run here (it creates a
 * user and needs root). `bash -n` parses it; shellcheck lints it when it is on
 * PATH (it isn't pinned in mise.toml yet, H-145); the rest reads the text for
 * what the script must do, in the order it must do it.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HAPI_CHECKOUT, HAPI_USER } from "../../src/stack/up";

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
  expect(text).toContain(`[[ -d "$dest/.git" ]]`);
  expect(text).toMatch(/grep -q "\^\$MISE_VERSION "/);
  expect(text).toMatch(/grep -qxF "\$line" "\$profile"/);
});

test("creates the hapi user with subordinate IDs wide enough for the Squid rock's uid 584792", () => {
  expect(text).toContain(`readonly HAPI_USER=${HAPI_USER}`);
  const count = Number(/readonly SUBID_COUNT=(\d+)/.exec(text)?.[1]);
  expect(count).toBeGreaterThan(584792);
  expect(text).toContain(`-K SUB_UID_COUNT="$SUBID_COUNT" -K SUB_GID_COUNT="$SUBID_COUNT"`);
  // hapi must never be in the rootful daemon's docker group.
  expect(text).toMatch(/grep -qx docker/);
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

test("clones into ~hapi/hapi-factory (where up re-execs), from a URL or a local path, owned by hapi", () => {
  expect(text).toContain(`dest="/home/$HAPI_USER/${HAPI_CHECKOUT}"`);
  expect(text).toContain(`git -c safe.directory='*' clone --no-local "$src" "$dest"`);
  expect(text).toContain(`chown -R "$HAPI_USER:$HAPI_USER" "$dest"`);
  // The default source is this checkout's origin remote: no account name in the script.
  expect(text).toContain("remote get-url origin");
});

test("prints the next steps: the rootless check, mise trust and install as hapi with its XDG_RUNTIME_DIR, the secrets join and add-machine, then up", () => {
  const steps = text.slice(text.indexOf("next_steps() {"));
  for (const s of [
    "sudo -iu $HAPI_USER docker info --format '{{.SecurityOptions}}'",
    "export XDG_RUNTIME_DIR=/run/user/$uid",
    "mise trust && mise install && mise run setup",
    "sudo install -o $HAPI_USER -g $HAPI_USER -m 0600 private/secrets.enc.yaml private/secrets.recipients.yaml private/recovery.age",
    "mise run secrets:join -- --store ~/.config/hapi/secrets.enc.yaml --name $HAPI_USER",
    "mise run secrets:add-machine -- --name $HAPI_USER --recipient <age1...>",
    "mise run secrets:check",
    "mise run up",
  ]) {
    expect([s, steps.includes(s)]).toEqual([s, true]);
  }
});
