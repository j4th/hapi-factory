/**
 * The two check workflows (archon/workflows/hapi/) and the two check work orders (archon/checks/), read as
 * files (Plan 02 Task 6). The integration test (Task 8) runs hapi-check-run in a real run container; the paid
 * check (Task 11) runs hapi-check-guard. Here: what they declare.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { loadWorkOrder } from "../../src/workorder/validate";
import { REPO } from "../stack/helpers";

const PACK = join(REPO, "archon", "workflows", "hapi");
const load = (name: string): Record<string, any> => parse(readFileSync(join(PACK, `${name}.yaml`), "utf8"));
const CHECKS = ["hapi-check-run", "hapi-check-guard"] as const;

for (const name of CHECKS) {
  describe(name, () => {
    const w = load(name);
    const nodes: Record<string, any>[] = w.nodes;

    test("it parses, is named for its file, and has nodes with unique ids that depend only on earlier ones", () => {
      expect(w.name).toBe(name);
      expect(typeof w.description).toBe("string");
      expect(nodes.length).toBeGreaterThan(0);
      const seen = new Set<string>();
      for (const n of nodes) {
        for (const d of (n.depends_on as string[] | undefined) ?? []) expect([n.id, seen.has(d)]).toEqual([n.id, true]);
        expect(seen.has(n.id)).toBe(false);
        seen.add(n.id);
      }
    });

    test("it declares both inputs Archon is passed (an undeclared input is refused before the run), and no worktree", () => {
      expect(w.inputs).toEqual({ work_order_id: { required: true }, traceparent: { default: "" } });
      expect(w.worktree).toEqual({ enabled: false });
    });

    test("no node turns Pi's extensions off: hapi-guard rides on them", () => {
      expect(JSON.stringify(w)).not.toMatch(/enableExtensions/);
      for (const n of nodes) expect(n.pi?.enableExtensions).not.toBe(false);
    });

    test("no node uses approval: (deprecated in Archon 0.12.1; a run that pauses is a failed run)", () => {
      for (const n of nodes) expect([n.id, "approval" in n]).toEqual([n.id, false]);
    });
  });
}

describe("hapi-check-run", () => {
  const w = load("hapi-check-run");
  const nodes: Record<string, any>[] = w.nodes;
  const bash = (id: string): string => nodes.find((n) => n.id === id)?.bash;

  test("it has no AI node: every node is bash, so a check costs nothing", () => {
    for (const n of nodes) {
      expect([n.id, typeof n.bash]).toEqual([n.id, "string"]);
      for (const key of ["prompt", "provider", "model", "command", "loop", "allowed_tools"]) expect([n.id, key, key in n]).toEqual([n.id, key, false]);
    }
  });

  test("its nodes are the controls Task 8 reads: identity, the strip, Bun, git, writable and read-only paths, the posture, a commit", () => {
    expect(nodes.map((n) => n.id)).toEqual(["whoami", "strip", "bun-no-install", "git-scope", "writable", "read-only", "posture", "commit"]);
    expect(bash("whoami")).toContain("whoami");
    expect(bash("strip")).toContain("test ! -e .pi -a ! -e .agents -a ! -e .archon");
    expect(bash("bun-no-install")).toContain('test "$BUN_OPTIONS" = --no-install');
    expect(bash("bun-no-install")).toContain("left-pad");
    expect(bash("bun-no-install")).toContain("Cannot find package");
    expect(bash("git-scope")).toContain("git config --show-scope --get core.hooksPath");
    expect(bash("writable")).toContain('"$HOME"/x');
    expect(bash("writable")).toContain("/.archon/x");
    expect(bash("writable")).toContain("/opt/hapi/pi-agent/probe");
    expect(bash("read-only")).toContain("/opt/hapi/pi-agent/models.json");
    expect(bash("read-only")).toContain("Read-only file system");
    expect(bash("commit")).toContain("git commit");
  });

  test("the posture node prints what the integration test records: uid, capabilities, no-new-privs, versions, proxy answers, mount flags", () => {
    const p = bash("posture");
    for (const s of ["id -u", "CapEff", "NoNewPrivs", "/app/package.json", "pi-coding-agent/package.json", "node --version", "uv --version", "python3.14 --version"]) expect(p).toContain(s);
    expect(p).toContain("curl -s -o /dev/null");
    // The proxy's answer to the CONNECT, then the origin's: a refused CONNECT leaves %{http_code} at 000.
    expect(p).toContain("-w '%{http_connect} %{http_code}'");
    for (const u of ["https://api.anthropic.com/", "https://github.com/"]) expect(p).toContain(u);
    expect(p).toContain("/proc/self/mountinfo");
    for (const m of ["/tmp", '"$HOME"', "/.archon", "/opt/hapi/pi-agent"]) expect(p).toContain(m);
  });
});

describe("hapi-check-guard", () => {
  const w = load("hapi-check-guard");

  test("it has one node, a Pi node on Haiku at low effort with the file and shell tools, and the fixed prompt", () => {
    expect(w.nodes).toHaveLength(1);
    const [n] = w.nodes;
    expect(n.provider).toBe("pi");
    expect(n.model).toBe("anthropic/claude-haiku-5-5");
    expect(n.effort).toBe("low");
    expect(n.allowed_tools).toEqual(["read", "write", "edit", "ls", "bash"]);
    expect(n.prompt).toBe(
      "1. Use the write tool to replace AGENTS.md with the single line hello. 2. Run the shell command `date`. 3. Say in one line what happened to each.",
    );
  });

  test("its run is capped at $0.25", () => {
    expect(w.budget).toEqual({ max_spend_usd: 0.25 });
  });
});

describe("the check work orders", () => {
  test("work-order.yaml validates, with no extra egress and the guard check workflow", () => {
    const o = loadWorkOrder(join(REPO, "archon", "checks", "work-order.yaml"));
    expect(o.egress_extra).toEqual([]);
    expect(o.workflow).toBe("hapi-check-guard");
    expect(o.id).toBe("0001-check-guard");
  });

  test("work-order-budget.yaml validates too, with the same workflow and an id of its own, so the paid check's second run has its own run key", () => {
    const a = loadWorkOrder(join(REPO, "archon", "checks", "work-order.yaml"));
    const b = loadWorkOrder(join(REPO, "archon", "checks", "work-order-budget.yaml"));
    expect(b.workflow).toBe("hapi-check-guard");
    expect(b.egress_extra).toEqual([]);
    expect(b.id).toBe("0002-check-guard-budget");
    expect(b.id).not.toBe(a.id);
    // The budget order is the one that trips the cap.
    expect(b.budget.usd).toBeLessThan(a.budget.usd);
  });
});
