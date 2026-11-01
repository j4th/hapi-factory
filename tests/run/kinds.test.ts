/**
 * The run kinds' profiles (src/run/kinds.ts; design §3.5): one profile per kind decides its container's zone
 * (whose keys its docker CLI gets), its egress proxy, its prelude, its workflow, whether it takes an inputs dir,
 * its extra binds and the outputs it copies out. Pure: nothing runs.
 */
import { describe, expect, test } from "bun:test";
import { egressOf, KIND_LABEL, kindProfile, MAX_OUTPUTS, proxyZoneOf, RUN_INPUTS, RUN_KINDS } from "../../src/run/kinds";
import { proxyEnv } from "../../src/stack/env";

const WORKER_OUTPUTS = [
  { name: "result.json", limit: "result" },
  { name: "transcript.jsonl", limit: "transcript" },
  { name: "decisions.jsonl", limit: "decisions" },
  { name: "run.bundle", limit: "bundle" },
];

/** design §3.5's table, as Task 8 writes it: each kind's profile without its extraBinds. */
const TABLE = {
  worker: { kind: "worker", zone: "archon", egress: "egress-archon", prelude: "run.sh", workflow: undefined, inputs: false, outputs: WORKER_OUTPUTS },
  fix: { kind: "fix", zone: "archon", egress: "egress-archon", prelude: "run.sh", workflow: undefined, inputs: true, outputs: WORKER_OUTPUTS },
  verify: {
    kind: "verify", zone: undefined, egress: "egress-archon", prelude: "verify.sh", workflow: "factory-verify", inputs: false,
    outputs: [{ name: "result.json", limit: "result" }, { name: "transcript.jsonl", limit: "transcript" }, { name: "verify.json", limit: "result" }],
  },
  review: {
    kind: "review", zone: "review", egress: "egress-review", prelude: "review.sh", workflow: "factory-review", inputs: true,
    outputs: [
      { name: "result.json", limit: "result" },
      { name: "transcript.jsonl", limit: "transcript" },
      { name: "decisions.jsonl", limit: "decisions" },
      { name: "coderabbit.ndjson", limit: "decisions" },
    ],
  },
} as const;

describe("kindProfile", () => {
  test("each kind's profile is the table's", () => {
    expect(RUN_KINDS).toEqual(["worker", "verify", "review", "fix"]);
    for (const k of RUN_KINDS) {
      const { extraBinds, ...rest } = kindProfile(k);
      expect([k, rest]).toEqual([k, TABLE[k] as unknown as typeof rest]);
      // Task 11 gives review its one extra bind; here every kind's is empty.
      expect([k, extraBinds({ buildDir: "/b" })]).toEqual([k, []]);
    }
    expect(MAX_OUTPUTS).toBe(4);
    expect(MAX_OUTPUTS).toBe(Math.max(...RUN_KINDS.map((k) => kindProfile(k).outputs.length)));
    expect(KIND_LABEL).toBe("org.hapi.kind");
  });

  test("RUN_INPUTS names the inputs dir's three files, with no base.txt and no bundle, and no kind copies out a review.json", () => {
    // Ruling m46 (3): the work order and its task text are /run/hapi/order.json and task.md in every kind's container, not an input.
    expect(RUN_INPUTS).toEqual({ diff: "diff.patch", verify: "verify.json", findings: "findings.md" });
    const names = Object.values(RUN_INPUTS);
    for (const n of ["base.txt", "run.bundle", "order.json", "task.md"]) expect([n, names.includes(n as never)]).toEqual([n, false]);
    for (const k of RUN_KINDS) expect([k, kindProfile(k).outputs.some((o) => o.name === "review.json")]).toEqual([k, false]);
  });

  test("only verify holds no zone's keys; only review takes the review zone's keys and proxy", () => {
    expect(RUN_KINDS.filter((k) => kindProfile(k).zone === undefined)).toEqual(["verify"]);
    expect(RUN_KINDS.filter((k) => kindProfile(k).egress === "egress-review")).toEqual(["review"]);
    expect(RUN_KINDS.filter((k) => kindProfile(k).inputs)).toEqual(["review", "fix"]);
  });

  test("a profile's egress alias is the host its proxy variables name", () => {
    for (const k of RUN_KINDS) {
      const p = kindProfile(k);
      expect([k, new URL(proxyEnv(proxyZoneOf(p)).HTTP_PROXY!).hostname]).toEqual([k, p.egress]);
    }
    expect(new URL(proxyEnv("review").HTTP_PROXY!).hostname).toBe("egress-review");
  });

  test("egressOf: the project's egress-archon container for worker, fix and verify; its egress-review container for review", () => {
    const d = { project: "hapi-int-ab12cd34", egress: "hapi-int-ab12cd34-egress-archon-1" };
    expect(RUN_KINDS.map((k) => [k, egressOf(d, kindProfile(k))])).toEqual([
      ["worker", ["hapi-int-ab12cd34-egress-archon-1"]],
      ["verify", ["hapi-int-ab12cd34-egress-archon-1"]],
      ["review", ["hapi-int-ab12cd34-egress-review-1"]],
      ["fix", ["hapi-int-ab12cd34-egress-archon-1"]],
    ]);
  });

  test("a profile can't be changed in place, and an unknown kind has none", () => {
    const p = kindProfile("verify");
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.outputs)).toBe(true);
    expect(() => kindProfile("build" as never)).toThrow('"build" is not a run kind (worker, verify, review or fix)');
  });
});
