import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { effectiveModes } from "../../src/policy/paths";
import { loadWorkOrder, validateWorkOrder, WorkOrderError } from "../../src/workorder/validate";

const load = (file: string): unknown => parse(readFileSync(file, "utf8"));
/** A fresh copy of the spec §6 example, to break one field at a time. */
const example = (): Record<string, any> => load("tests/fixtures/order-0002.yaml") as Record<string, any>;

function workOrderError(obj: unknown): WorkOrderError {
  try {
    validateWorkOrder(obj);
  } catch (e) {
    if (e instanceof WorkOrderError) return e;
    throw e;
  }
  throw new Error("expected validateWorkOrder to throw a WorkOrderError");
}

test("accepts spec §6 example", () => {
  expect(validateWorkOrder(load("tests/fixtures/order-0002.yaml")).id).toBe("0002-search-partners-tool");
});

test("the validated order keeps every field", () => {
  const w = validateWorkOrder(example());
  expect(w).toEqual({
    id: "0002-search-partners-tool",
    lane: "factory",
    workflow: "factory-task",
    risk: "medium",
    roles: { implement: "medium", review: "medium" },
    budget: { usd: 3, turns: 40, minutes: 30 },
    pieces: [
      { id: "search-partners", files: ["src/odoo_mcp/tools/partners.py", "tests/tools/test_partners.py"], size: "small" },
    ],
    verify: { smoke: true },
    egress_extra: ["odoo.internal"],
    trace: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
    sources: ["docs/research/odoo-external-api.md", "docs/design/odoo-mcp.md"],
  });
});

test("rejects model ids in roles", () => {
  const o = example();
  o.roles.implement = "claude-opus-5-5";
  const e = workOrderError(o);
  expect(e.path).toBe("/roles/implement");
  expect(e.message).toContain("small, medium, large");
});

test("rejects malformed traceparent", () => {
  const o = example();
  o.trace.traceparent = "00-xyz";
  expect(workOrderError(o).path).toBe("/trace/traceparent");
});

describe("rejects", () => {
  const cases: [string, (o: Record<string, any>) => void, string][] = [
    ["an unknown top-level key", (o) => (o.model = "claude-opus-5-5"), "/model"],
    ["an unknown nested key", (o) => (o.roles.planner = "large"), "/roles/planner"],
    ["a missing required field", (o) => delete o.trace, "/trace"],
    ["a traceparent with the wrong flags byte", (o) => (o.trace.traceparent = o.trace.traceparent.replace(/01$/, "02")), "/trace/traceparent"],
    ["an uppercase traceparent", (o) => (o.trace.traceparent = o.trace.traceparent.toUpperCase()), "/trace/traceparent"],
    ["an unknown risk", (o) => (o.risk = "extreme"), "/risk"],
    ["an unknown lane", (o) => (o.lane = "yolo"), "/lane"],
    ["an id that isn't a slug", (o) => (o.id = "../0002"), "/id"],
    ["a zero budget", (o) => (o.budget.usd = 0), "/budget/usd"],
    ["fractional turns", (o) => (o.budget.turns = 1.5), "/budget/turns"],
    ["no pieces", (o) => (o.pieces = []), "/pieces"],
    ["an absolute file path", (o) => (o.pieces[0].files[0] = "/etc/passwd"), "/pieces/0/files/0"],
    ["a file path that climbs out of the repo", (o) => (o.pieces[0].files[1] = "src/../../x.py"), "/pieces/0/files/1"],
    ["a bad piece size", (o) => (o.pieces[0].size = "huge"), "/pieces/0/size"],
    ["a duplicate piece id", (o) => o.pieces.push({ ...o.pieces[0] }), "/pieces/1/id"],
    ["an egress_extra entry with a scheme", (o) => (o.egress_extra = ["https://odoo.internal"]), "/egress_extra/0"],
    ["a source outside the repo", (o) => (o.sources = ["../secrets.md"]), "/sources/0"],
    // Control characters as src/policy/paths.ts defines them: U+0000-U+001F and U+007F-U+009F.
    ["a file path with a DEL", (o) => (o.pieces[0].files[0] = "src/a\u007fb.ts"), "/pieces/0/files/0"],
    ["a file path with a C1 control (NEL)", (o) => (o.pieces[0].files[0] = "src/a\u0085b.ts"), "/pieces/0/files/0"],
    ["a source with a C1 control", (o) => (o.sources = ["docs/a\u009fb.md"]), "/sources/0"],
    // The repo root itself, which effectiveModes refuses as not a file path.
    ["the repo root as a file path", (o) => (o.pieces[0].files[0] = "."), "/pieces/0/files/0"],
    ["the repo root as a file path, with a slash", (o) => (o.pieces[0].files[0] = "./"), "/pieces/0/files/0"],
    ["the repo root, spelled ././", (o) => (o.sources = ["././"]), "/sources/0"],
    // A line separator before the '..' segment still leaves a '..' segment.
    ["a '..' segment after a line separator", (o) => (o.pieces[0].files[0] = "a /../../x.py"), "/pieces/0/files/0"],
    ["a non-boolean smoke flag", (o) => (o.verify.smoke = "yes"), "/verify/smoke"],
  ];
  for (const [name, breakIt, path] of cases) {
    test(name, () => {
      const o = example();
      breakIt(o);
      expect(workOrderError(o).path).toBe(path);
    });
  }

  test("a non-object", () => {
    expect(workOrderError(null).path).toBe("");
    expect(workOrderError("id: x").path).toBe("");
  });
});

test("a piece path the schema accepts is one the guard's effectiveModes accepts, and the other way round", () => {
  // So an order's declared scope never validates in Hermes, CI and prepare, then fails at run time.
  const policy = { protectedPaths: {} };
  for (const path of ["src/a.ts", "./src/a.ts", "src/./a.ts", "src/a/", "...", ".github/workflows/ci.yml", "a b.ts", ".", "./", "././", "src/a\u007fb.ts", "src/a\u0085b.ts", "src/a\u009fb.ts", "src/a b.ts", "src/../../x", "a /../../x"]) {
    const o = example();
    o.pieces[0].files = [path];
    let schema = true;
    try {
      validateWorkOrder(o);
    } catch (e) {
      if (!(e instanceof WorkOrderError)) throw e;
      schema = false;
    }
    let guard = true;
    try {
      effectiveModes(policy, path);
    } catch {
      guard = false;
    }
    expect([JSON.stringify(path), schema]).toEqual([JSON.stringify(path), guard]);
  }
});

describe("egress_extra may not name a forge host (spec §4.3, §10)", () => {
  // A work order's egress_extra joins the archon zone at run time, and that zone has no forge route.
  const forges: [string, string][] = [
    ["github.com", "github.com"],
    ["api.github.com", "github.com"],
    ["raw.githubusercontent.com", "githubusercontent.com"],
    ["avatars.githubassets.com", "githubassets.com"],
    ["ghcr.io", "ghcr.io"],
    ["gitlab.com", "gitlab.com"],
    ["registry.gitlab.com", "gitlab.com"],
    ["bitbucket.org", "bitbucket.org"],
    ["api.bitbucket.org", "bitbucket.org"],
  ];
  for (const [host, forge] of forges) {
    test(host, () => {
      const o = example();
      o.egress_extra = ["odoo.internal", host];
      expect(workOrderError(o).issues).toEqual([
        {
          path: "/egress_extra/1",
          message: `"${host}" is a forge host (${forge}); the archon zone has no forge route (spec §4.3)`,
        },
      ]);
    });
  }

  test("look-alike domains are not forge hosts", () => {
    const o = example();
    o.egress_extra = ["notgithub.com", "github.com.mirror.internal", "gitlab.company.internal", "ghcr.io.example"];
    expect(validateWorkOrder(o).egress_extra).toHaveLength(4);
  });
});

describe("loadWorkOrder", () => {
  test("reads and validates a YAML file", () => {
    expect(loadWorkOrder("tests/fixtures/order-0002.yaml").id).toBe("0002-search-partners-tool");
  });

  test("reports schema errors with the path", () => {
    expect(() => loadWorkOrder("tests/fixtures/order-bad-traceparent.yaml")).toThrow(WorkOrderError);
  });

  test("reports a missing file at the root path", () => {
    try {
      loadWorkOrder("tests/fixtures/no-such-order.yaml");
      throw new Error("expected a WorkOrderError");
    } catch (e) {
      expect(e).toBeInstanceOf(WorkOrderError);
      expect((e as WorkOrderError).path).toBe("");
    }
  });
});
