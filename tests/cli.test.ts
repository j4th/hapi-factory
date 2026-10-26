import { afterEach, expect, spyOn, test } from "bun:test";
import { main, register } from "../src/cli";
import { HAPI_VERSION } from "../src/version";
import pkg from "../package.json";

// Capture console output so the test run stays quiet and we can assert on it.
let restore: (() => void)[] = [];
function capture(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    out.push(a.map(String).join(" "));
  });
  const error = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    err.push(a.map(String).join(" "));
  });
  restore.push(() => log.mockRestore(), () => error.mockRestore());
  return { out, err };
}
afterEach(() => {
  for (const r of restore) r();
  restore = [];
});

test("prints version", async () => {
  const { out } = capture();
  expect(await main(["--version"])).toBe(0);
  expect(out.join("\n")).toContain("0.1.0");
});

test("unknown command exits 2", async () => {
  const { err } = capture();
  expect(await main(["nope"])).toBe(2);
  expect(err.join("\n")).toContain("unknown command 'nope'");
});

test("no command prints usage to stderr and exits 2", async () => {
  const { out, err } = capture();
  expect(await main([])).toBe(2);
  expect(out).toEqual([]);
  expect(err.join("\n")).toContain("Usage: hapi <command>");
});

test("--help prints usage to stdout and exits 0", async () => {
  const { out } = capture();
  expect(await main(["--help"])).toBe(0);
  expect(out.join("\n")).toContain("Usage: hapi <command>");
});

test("registered multi-word command gets the remaining args and sets the exit code", async () => {
  capture();
  let got: string[] | undefined;
  register("t-group t-run", (args) => {
    got = args;
    return 7;
  });
  expect(await main(["t-group", "t-run", "--flag", "value"])).toBe(7);
  expect(got).toEqual(["--flag", "value"]);
});

test("registered commands are listed in --help with their summary", async () => {
  const { out } = capture();
  register("t-listed", () => 0, "a listed test command");
  expect(await main(["--help"])).toBe(0);
  expect(out.join("\n")).toMatch(/t-listed\s+a listed test command/);
});

test("a group word alone is an unknown command", async () => {
  const { err } = capture();
  register("t-only sub", () => 0);
  expect(await main(["t-only"])).toBe(2);
  expect(err.join("\n")).toContain("unknown command 't-only'");
});

test("registering the same command twice throws", () => {
  register("t-dup", () => 0);
  expect(() => register("t-dup", () => 0)).toThrow("already registered: t-dup");
});

test("register rejects names that could never be matched", () => {
  expect(() => register("", () => 0)).toThrow("invalid command name");
  expect(() => register("--x", () => 0)).toThrow("invalid command name");
  expect(() => register("t-grp --x", () => 0)).toThrow("invalid command name");
});

test("a handler that throws exits 1 and reports the error", async () => {
  const { err } = capture();
  register("t-boom", () => {
    throw new Error("kaboom");
  });
  expect(await main(["t-boom"])).toBe(1);
  expect(err.join("\n")).toContain("hapi t-boom: kaboom");
});

test("HAPI_VERSION matches package.json", () => {
  expect(HAPI_VERSION).toBe("0.1.0");
  expect(pkg.version).toBe(HAPI_VERSION);
});

test("workorder validate prints the id of a valid work order and exits 0", async () => {
  const { out, err } = capture();
  expect(await main(["workorder", "validate", "tests/fixtures/order-0002.yaml"])).toBe(0);
  expect(out).toEqual(["0002-search-partners-tool"]);
  expect(err).toEqual([]);
});

test("workorder validate prints path: message for an invalid work order and exits 1", async () => {
  const { out, err } = capture();
  expect(await main(["workorder", "validate", "tests/fixtures/order-bad-traceparent.yaml"])).toBe(1);
  expect(out).toEqual([]);
  expect(err).toHaveLength(1);
  expect(err[0]).toStartWith("/trace/traceparent: must match pattern");
});

test("workorder validate on a missing file exits 1", async () => {
  const { err } = capture();
  expect(await main(["workorder", "validate", "tests/fixtures/no-such-order.yaml"])).toBe(1);
  expect(err.join("\n")).toContain("no-such-order.yaml");
});

test("workorder validate needs exactly one path", async () => {
  const { err } = capture();
  expect(await main(["workorder", "validate"])).toBe(2);
  expect(await main(["workorder", "validate", "a.yaml", "b.yaml"])).toBe(2);
  expect(err.join("\n")).toContain("usage: hapi workorder validate <path>");
});
