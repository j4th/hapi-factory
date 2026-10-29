/**
 * tools.archon-validate and tools.hermes-validate: each tool's own reading of
 * the deployed config (Review Focus 5: an upstream that ignores a generated
 * key). Both run the stack's own image with no network and no secret, the
 * deployed config mounted read-only. The outputs here have the shapes the
 * pinned images printed when run that way (tests/audit/fixtures/).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { runAudit } from "../../src/audit/index";
import { ARCHON_IMAGE, cleanup, cleanWorld, hermesMerge, HERMES_IMAGE, only, readJson } from "./helpers";

afterEach(cleanup);

type World = Awaited<ReturnType<typeof cleanWorld>>;
const check = async (w: World, id: string) => only(await runAudit(w.ctx), id);
const runOf = (w: World, image: string) => w.calls.find((c) => c[0] === "docker" && c[1] === "run" && c.includes(image));

describe("tools.archon-validate", () => {
  test("no errors, no parse warnings and every alias and tier read as generated passes (H-030)", async () => {
    const r = await check(await cleanWorld(), "tools.archon-validate");
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("24 workflows");
    expect(r.detail).toContain("8 aliases and 3 tiers");
  });

  test("runs the stack's Archon image offline, read-only, with no secret: only the deployed config and Pi dir, read-only", async () => {
    const w = await cleanWorld();
    await check(w, "tools.archon-validate");
    const cmd = runOf(w, ARCHON_IMAGE)!;
    for (const flag of ["--rm", "--read-only", "--network", "none", "--pull", "never", "--cap-drop", "ALL"]) expect(cmd).toContain(flag);
    expect(cmd).toContain(`${join(w.build, "archon", "config.yaml")}:/.archon/config.yaml:ro`);
    expect(cmd).toContain(`${join(w.build, "pi")}:/opt/hapi/pi-agent:ro`);
    expect(cmd.join(" ")).not.toContain("env-file");
    expect(cmd.join(" ")).not.toContain(".env");
    expect(cmd).toContain("PI_OFFLINE=1");
  });

  test("Archon v0.12.1's own parse warnings (unknown keys it drops) fail, quoting them", async () => {
    const w = await cleanWorld();
    w.archonValidate = { code: 0, out: readJson("archon-validate-parse-warning-v0.12.1.json") };
    const r = await check(w, "tools.archon-validate");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("Node 'a': unknown key 'bogus_node_key' will be ignored.");
    expect(r.detail).toContain("Workflow 'hapi-probe': unknown key 'unknown_top' will be ignored.");
  });

  test("a validation error fails; so do Archon's own failure and output it can't read", async () => {
    const w = await cleanWorld();
    w.archonValidate = { code: 1, out: { results: [{ workflowName: "x", valid: false, issues: [{ level: "error", field: "nodes", message: "node 'a' has no type" }] }], summary: {} } };
    let r = await check(w, "tools.archon-validate");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("x: node 'a' has no type");

    w.archonValidate = { code: 1, out: { ok: false, error: "Error: Invalid model binding config\nmore" } };
    r = await check(w, "tools.archon-validate");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("Error: Invalid model binding config");

    w.archonValidate = { code: 0, out: "not json" };
    r = await check(w, "tools.archon-validate");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("could not read");
  });

  test("a command that exits non-zero fails, naming it, even when it prints clean output", async () => {
    // validate workflows: clean JSON, but exit 3.
    let w = await cleanWorld();
    w.archonValidate = { code: 3, out: readJson("archon-validate-v0.12.1.json") };
    let r = await check(w, "tools.archon-validate");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("archon validate workflows --json exited 3");

    // ai alias list and ai tier list: every binding read as generated, but a non-zero exit.
    for (const [nth, command, code] of [
      [2, "archon ai alias list --json", 1],
      [3, "archon ai tier list --json", 2],
    ] as const) {
      w = await cleanWorld();
      const real = w.ctx.exec;
      w.ctx.exec = async (cmd) => {
        const out = await real(cmd);
        if (!(cmd[1] === "run" && cmd.includes(ARCHON_IMAGE))) return out;
        let n = 0;
        return { ...out, stdout: out.stdout.replace(/@@hapi-audit 0@@/g, (m) => (++n === nth ? `@@hapi-audit ${code}@@` : m)) };
      };
      r = await check(w, "tools.archon-validate");
      expect([command, r.status]).toEqual([command, "fail"]);
      expect([command, r.detail]).toEqual([command, expect.stringContaining(`${command} exited ${code}`)]);
    }
  });

  test("an alias Archon doesn't read as generated fails, naming it (H-030)", async () => {
    const w = await cleanWorld();
    const real = w.ctx.exec;
    w.ctx.exec = async (cmd) => {
      const r = await real(cmd);
      return cmd[1] === "run" && cmd.includes(ARCHON_IMAGE) ? { ...r, stdout: r.stdout.replace(/\{"name":"@implement-retry"[^}]*\}[^}]*\}[^}]*\}\}?,?/, "") } : r;
    };
    const r = await check(w, "tools.archon-validate");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("@implement-retry");
  });

  test("without the built image it falls back to the Dockerfile's pinned FROM; with neither it skips, and never pulls", async () => {
    const w = await cleanWorld();
    w.images.delete(ARCHON_IMAGE);
    const from = /^FROM (\S+)$/m.exec(readFileSync(join(w.ctx.root, "stack", "archon", "Dockerfile"), "utf8").split("\n").filter((l) => l.startsWith("FROM ")).at(-1)!)![1]!;
    w.images.add(from);
    expect((await check(w, "tools.archon-validate")).status).toBe("pass");
    expect(runOf(w, from)).toBeDefined();

    w.images.delete(from);
    const r = await check(w, "tools.archon-validate");
    expect(r.status).toBe("skip");
    expect(r.detail).toContain(ARCHON_IMAGE);
    expect(r.detail).toContain("never pulls");
  });

  test("no deployed Archon config is a skip", async () => {
    const w = await cleanWorld();
    rmSync(join(w.build, "archon"), { recursive: true });
    expect((await check(w, "tools.archon-validate")).status).toBe("skip");
  });
});

describe("tools.hermes-validate", () => {
  test("every generated key known to Hermes and read back as the deployed file says, and no config issue, passes", async () => {
    const r = await check(await cleanWorld(), "tools.hermes-validate");
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("agent.reasoning_effort");
    expect(r.detail).toContain("model.default and model.provider");
    expect(r.detail).toContain("no _config_version");
  });

  test("runs the stack's Hermes image offline, read-only, with no secret", async () => {
    const w = await cleanWorld();
    await check(w, "tools.hermes-validate");
    const cmd = runOf(w, HERMES_IMAGE)!;
    for (const flag of ["--rm", "--read-only", "--network", "none", "--pull", "never"]) expect(cmd).toContain(flag);
    expect(cmd).toContain(`${join(w.build, "hermes", "config.yaml")}:/opt/data/config.yaml:ro`);
    expect(cmd.join(" ")).not.toContain("env-file");
  });

  test("a key Hermes doesn't know fails, naming it (a renamed or ignored safety key reads as enforced otherwise)", async () => {
    const w = await cleanWorld();
    const file = join(w.build, "hermes", "config.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("  allow_lazy_installs: false", "  allow_lazy_install: false"));
    w.hermes.effective = hermesMerge(w.hermes.defaults, YAML.parse(readFileSync(file, "utf8")));
    const r = await check(w, "tools.hermes-validate");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("security.allow_lazy_install");
  });

  test("a key under model fails unless it is one of the reviewed keys: DEFAULT_CONFIG's model is a string, so it can't say", async () => {
    const w = await cleanWorld();
    const file = join(w.build, "hermes", "config.yaml");
    const cfg = YAML.parse(readFileSync(file, "utf8"));
    for (const [rename, says] of [
      [(m: Record<string, unknown>) => ((m.defualt = m.default), delete m.default), "model.defualt is not a key Hermes knows"],
      [(m: Record<string, unknown>) => (m.base_url = "https://example.invalid"), "model.base_url is not a key Hermes knows"],
    ] as const) {
      const c = structuredClone(cfg);
      rename(c.model);
      writeFileSync(file, YAML.stringify(c));
      w.hermes.effective = hermesMerge(w.hermes.defaults, c);
      const r = await check(w, "tools.hermes-validate");
      expect([says, r.status]).toEqual([says, "fail"]);
      expect(r.detail).toContain(says);
    }
  });

  test("a generated mapping whose Hermes default is not a non-empty mapping, with no reviewed key list, fails closed", async () => {
    const w = await cleanWorld();
    const file = join(w.build, "hermes", "config.yaml");
    const cfg = YAML.parse(readFileSync(file, "utf8"));
    // DEFAULT_CONFIG.providers is {}: nothing there says which keys Hermes reads under it.
    cfg.providers = { anthropic: { base_url: "https://example.invalid" } };
    writeFileSync(file, YAML.stringify(cfg));
    w.hermes.effective = hermesMerge(w.hermes.defaults, cfg);
    const r = await check(w, "tools.hermes-validate");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("providers.anthropic is not a key Hermes knows");
  });

  test("a value Hermes reads differently fails, naming the key", async () => {
    const w = await cleanWorld();
    (w.hermes.effective as any).approvals.mode = "manual-ish";
    const r = await check(w, "tools.hermes-validate");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("Hermes reads approvals.mode differently from the deployed file");
  });

  test("an issue from Hermes's own validate_config_structure fails, quoting it", async () => {
    const w = await cleanWorld();
    w.hermes.issues = [{ severity: "warning", message: "Root-level key 'base_url' looks misplaced" }];
    const r = await check(w, "tools.hermes-validate");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("Root-level key 'base_url' looks misplaced");
  });

  test("mcp_servers entries are held to the keys Hermes v0.22.5 reads for a server", async () => {
    const w = await cleanWorld();
    const file = join(w.build, "hermes", "config.yaml");
    const cfg = YAML.parse(readFileSync(file, "utf8"));
    cfg.mcp_servers = { probe: { command: "npx", args: ["--yes", "x@1.0.0"], tools: { include: ["a"], prompts: false, resources: false }, trust: "untrusted", elicitation: { enabled: false }, sampling: { enabled: false } } };
    writeFileSync(file, YAML.stringify(cfg));
    w.hermes.effective = hermesMerge(w.hermes.defaults, cfg);
    expect((await check(w, "tools.hermes-validate")).status).toBe("pass");

    cfg.mcp_servers.probe.trusted = "no";
    writeFileSync(file, YAML.stringify(cfg));
    w.hermes.effective = hermesMerge(w.hermes.defaults, cfg);
    const r = await check(w, "tools.hermes-validate");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("mcp_servers.probe.trusted");
  });

  test("output it can't read fails; no image is a skip", async () => {
    const w = await cleanWorld();
    const real = w.ctx.exec;
    w.ctx.exec = async (cmd) => (cmd[1] === "run" && cmd.includes(HERMES_IMAGE) ? { code: 1, stdout: "", stderr: "Traceback: ModuleNotFoundError" } : real(cmd));
    let r = await check(w, "tools.hermes-validate");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("exited 1");

    w.ctx.exec = real;
    w.images.delete(HERMES_IMAGE);
    r = await check(w, "tools.hermes-validate");
    expect(r.status).toBe("skip");
  });
});
