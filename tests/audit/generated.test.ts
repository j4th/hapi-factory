/**
 * generated.drift: the deployed build/ equals a fresh `buildAll` of policy/
 * (any roster), and every running container was started from that build
 * (its org.hapi.build-sha256 label). The fresh build goes into a temp dir;
 * the deployed build/ is never written.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { runAudit } from "../../src/audit/index";
import { buildAll } from "../../src/generate/index";
import { loadPolicy } from "../../src/policy/load";
import { buildDigest } from "../../src/stack/up";
import { cleanup, cleanWorld, files, only, REPO, tempDir } from "./helpers";

afterEach(cleanup);

const drift = async (w: Awaited<ReturnType<typeof cleanWorld>>) => only(await runAudit(w.ctx), "generated.drift");
const edit = (path: string, from: string | RegExp, to: string) => {
  const text = readFileSync(path, "utf8");
  const next = text.replace(from, to);
  if (next === text) throw new Error(`no ${String(from)} in ${path}`);
  writeFileSync(path, next);
};

describe("generated.drift", () => {
  test("a deployed build equal to a fresh one, and every container started from it, passes", async () => {
    const w = await cleanWorld();
    const r = await drift(w);
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("roster anthropic");
    expect(r.detail).toContain("5 running containers");
  });

  test("it finds the roster the stack was built with (`up --roster budget`)", async () => {
    const w = await cleanWorld();
    const root = join(w.build, "..");
    const written = await buildAll(loadPolicy(join(REPO, "policy")), w.build, { roster: "budget" });
    const digest = buildDigest(written.map((p) => relative(root, p)), root);
    for (const c of w.containers) c.Config.Labels["org.hapi.build-sha256"] = digest;
    const r = await drift(w);
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("roster budget");
  });

  test("a hand edit to a YAML or JSON file fails, naming the file and the key, never the deployed value", async () => {
    const w = await cleanWorld();
    edit(join(w.build, "archon", "config.yaml"), /model: anthropic\/claude-opus-5-5\n    effort: high/, "model: anthropic/claude-opus-5-5\n    effort: xhigh-hand-edit");
    edit(join(w.build, "pi", "models.json"), '"maxTokens": 64000', '"maxTokens": 128000');
    const r = await drift(w);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("archon/config.yaml: aliases.@implement-retry.effort");
    expect(r.detail).toContain("pi/models.json");
    expect(r.detail).toContain("maxTokens");
    expect(r.detail).not.toContain("xhigh-hand-edit");
    expect(r.detail).not.toContain("128000");
  });

  test("HOST=0.0.0.0 in archon.env fails, naming HOST (Review Focus 4)", async () => {
    const w = await cleanWorld();
    edit(join(w.build, "archon", "archon.env"), "HOST=127.0.0.1", "HOST=0.0.0.0");
    const r = await drift(w);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("archon/archon.env: HOST");
    expect(r.detail).not.toContain("0.0.0.0");
  });

  test("an edited squid.conf fails, naming the file and the line", async () => {
    const w = await cleanWorld();
    const file = join(w.build, "egress", "archon.squid.conf");
    writeFileSync(file, readFileSync(file, "utf8").replace(/^http_access deny all$/m, "http_access allow all"));
    const r = await drift(w);
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/egress\/archon\.squid\.conf: line \d+ differs/);
  });

  test("a missing deployed file, or one that no longer parses, fails", async () => {
    const w = await cleanWorld();
    rmSync(join(w.build, "mcp", "hermes.mcp.json"));
    writeFileSync(join(w.build, "hermes", "config.yaml"), "approvals: [unclosed\n");
    const r = await drift(w);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("mcp/hermes.mcp.json: missing");
    expect(r.detail).toContain("hermes/config.yaml: does not parse");
  });

  test("a container started from another build fails, naming it; one with no build label too", async () => {
    const w = await cleanWorld();
    w.containers.find((c) => c.Name === "/hapi-archon-1")!.Config.Labels["org.hapi.build-sha256"] = "0".repeat(64);
    w.containers.find((c) => c.Name === "/hapi-egress-hermes-1")!.Config.Labels["org.hapi.build-sha256"] = "";
    const r = await drift(w);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("hapi-archon-1 was started from another build");
    expect(r.detail).toContain("hapi-egress-hermes-1 has no org.hapi.build-sha256 label");
    expect(r.detail).toContain("mise run up");
  });

  test("with the stack down it still compares the files, and says the labels were not checked", async () => {
    const w = await cleanWorld();
    w.containers.length = 0;
    const r = await drift(w);
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("the stack is not running, so no container's build label was checked");
  });

  test("no deployed build is a skip, naming where it looked", async () => {
    const w = await cleanWorld();
    rmSync(w.build, { recursive: true });
    const r = await drift(w);
    expect(r.status).toBe("skip");
    expect(r.detail).toContain(w.build);
    expect(r.detail).toContain("mise run up");
  });

  test("by default it reads hapi's checkout (~hapi/hapi-factory/build), from the passwd entry", async () => {
    const w = await cleanWorld();
    delete w.ctx.buildDir;
    const r = await drift(w);
    expect(w.calls).toContainEqual(["getent", "passwd", "hapi"]);
    expect(r.status).toBe("skip");
    expect(r.detail).toContain("/home/hapi/hapi-factory/build");

    // No hapi user on this host: nothing deployed to compare.
    w.ctx.exec = async (cmd) => (cmd[0] === "getent" ? { code: 2, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "no docker" });
    const none = only(await runAudit(w.ctx), "generated.drift");
    expect(none.status).toBe("skip");
    expect(none.detail).toContain("no hapi user");
    expect(none.detail).toContain("--build-dir");
  });

  test("under the dev bypass (HAPI_ALLOW_CURRENT_USER=1, not hapi) it reads this checkout's build/, as `up` would", async () => {
    const w = await cleanWorld();
    delete w.ctx.buildDir;
    w.ctx.user = "operator";
    w.ctx.env.HAPI_ALLOW_CURRENT_USER = "1";
    w.ctx.root = tempDir("hapi-audit-devroot-");
    const r = await drift(w);
    expect(r.detail).toContain(join(w.ctx.root, "build"));
  });

  test("it never writes the deployed build", async () => {
    const w = await cleanWorld();
    const before = files(w.build).map((f) => [f, statSync(join(w.build, f)).mtimeMs, readFileSync(join(w.build, f), "utf8")]);
    await runAudit(w.ctx);
    expect(files(w.build).map((f) => [f, statSync(join(w.build, f)).mtimeMs, readFileSync(join(w.build, f), "utf8")])).toEqual(before);
  });
});
