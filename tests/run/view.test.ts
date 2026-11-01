/**
 * `hapi run watch` and `hapi run list` (src/run/view.ts; design §3.2; spike 07 findings 5 and 15), and the
 * retention step of `reapRuns` (src/run/lifecycle.ts), on the fake world of ./helpers.ts. Every key-shaped
 * sample is built at run time, never written as a literal, so the pre-commit gitleaks scan passes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../src/cli";
import { reapRuns } from "../../src/run/lifecycle";
import { readRecord, recordDir, type RunRecord, writeRecord } from "../../src/run/records";
import { LIST_USAGE, MAX_LINE_CHARS, OVERLONG_LINE, streamLines, WATCH_USAGE } from "../../src/run/cli";
import { redactSecrets, sanitizeTerminal } from "../../src/run/sanitize";
import { runList, runWatch, transcriptLines } from "../../src/run/view";
import { capture, cleanup } from "../secrets/helpers";
import { treeSnapshot } from "../stack/helpers";
import { fakeRun, fakeSecret, NOW, seedRun, writeZoneEnv } from "./helpers";

afterEach(cleanup);

const ESC = "\x1b";
const ID = "ab12cd34ef56";
const N = `hapi-run-${ID}`;
const DAY = 86_400_000;

const pick = (alphabet: string, n: number) => [...randomBytes(n)].map((b) => alphabet[b % alphabet.length]).join("");
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** Shaped like an Anthropic key and a GitHub token, assembled at run time. */
const anthropicLike = () => ["sk", "ant", pick(ALNUM, 24)].join("-");
const githubLike = () => "gh" + "p_" + pick(ALNUM, 36);

/** A fake world with the archon zone's env file holding one fake secret. */
function ready(o: Parameters<typeof fakeRun>[0] = {}) {
  const f = fakeRun(o);
  const secret = fakeSecret("ANTHROPIC_API_KEY");
  writeZoneEnv(f.xdg, "archon", { ANTHROPIC_API_KEY: secret });
  return { ...f, secret };
}

/** Write a finished run's copied-out file. */
function writeOut(stateDir: string, id: string, name: string, text: string): void {
  const out = join(recordDir(stateDir, id), "out");
  mkdirSync(out, { recursive: true, mode: 0o700 });
  writeFileSync(join(out, name), text, { mode: 0o600 });
}

const row = (r: Record<string, unknown>) => JSON.stringify({ workflow_id: "f0e1d2c3-0000-4000-8000-000000000001", ts: "2026-10-29T12:00:01.000Z", ...r });

describe("sanitizeTerminal", () => {
  test("watch strips control sequences (Review Focus 5): ESC[2J, an OSC 8 hyperlink, a bare CR and BEL go; text, tabs and newlines stay", () => {
    const text = `${ESC}[2Jcleared\r\nsee ${ESC}]8;;https://example.com/${ESC}\\the link${ESC}]8;;${ESC}\\ here\x07\tthen\ragain\n`;
    expect(sanitizeTerminal(text)).toBe("cleared\nsee the link here\tthenagain\n");
  });

  test("CSI (7- and 8-bit), DCS, OSC ended by BEL, charset selects, NUL, DEL and C1 controls go; an unterminated string sequence takes the rest", () => {
    const text = `a${ESC}[1;31mred${ESC}[0m \x9b31mb ${ESC}Pq#0;2;0;0;0${ESC}\\c ${ESC}]0;title\x07d ${ESC}(Be\x00\x7f\x85f ${ESC}]52;c;ZXZpbA==`;
    expect(sanitizeTerminal(text)).toBe("ared b c d ef ");
    expect(sanitizeTerminal(`x${ESC}`)).toBe("x");
    expect(sanitizeTerminal("plain text: [node] Started, 100% done; tabs\tand ünïcödé")).toBe("plain text: [node] Started, 100% done; tabs\tand ünïcödé");
  });

  test("the bidi embedding, override and isolate controls go (H-220, Trojan Source): U+202A–202E and U+2066–2069; other text stays", () => {
    const controls = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069].map((c) => String.fromCodePoint(c));
    expect(sanitizeTerminal(`run ab12cd34ef56: ${controls.join("")}deliaf${controls[2]} ok`)).toBe("run ab12cd34ef56: deliaf ok");
    // Their neighbours stay: U+2029 and U+206A are not among them, nor is right-to-left text itself.
    expect(sanitizeTerminal("a\u2029b\u206ac שלום")).toBe("a\u2029b\u206ac שלום");
  });
});

describe("redactSecrets", () => {
  test("each exact value of 8 or more characters and each key format becomes [hapi: <NAME> redacted]; a shorter value stays", () => {
    const key = anthropicLike();
    const token = githubLike();
    const values = { LONG_SECRET: "fake-secret-value-long", INNER: "secret-value", SHORT: "abc1234" };
    expect(redactSecrets(`x fake-secret-value-long y secret-value z abc1234 ${key} ${token}`, values)).toBe(
      "x [hapi: LONG_SECRET redacted] y [hapi: INNER redacted] z abc1234 [hapi: anthropic redacted] [hapi: github-token redacted]",
    );
    // A value that holds regex syntax is matched as text.
    expect(redactSecrets("a (.*)+$x [b] c", { ODD: "(.*)+$x [b]" })).toBe("a [hapi: ODD redacted] c");
    // Every occurrence, not the first.
    expect(redactSecrets(`${key}/${key}`, {})).toBe("[hapi: anthropic redacted]/[hapi: anthropic redacted]");
  });

  test("a private key is redacted whole, from its BEGIN line to its END line, or to the end of the text, marked so, with no END line (ledger 168)", () => {
    const body = Array.from({ length: 3 }, () => randomBytes(48).toString("base64"));
    const begin = "-----BEGIN " + "OPENSSH PRIVATE KEY-----";
    const end = "-----END " + "OPENSSH PRIVATE KEY-----";
    const outs = [
      [`a\n${begin}\n${body.join("\n")}\n${end}\nb`, "a\n[hapi: private-key redacted]\nb"],
      [`a ${begin}\n${body.join("\n")}\nand prose`, "a [hapi: private-key redacted to the end of the text: no END line]"],
      // Two blocks are each redacted, and the text between them stays.
      [`${begin}\n${body[0]}\n${end}\nkeep this\n${begin}\n${body[1]}\n${end}`, "[hapi: private-key redacted]\nkeep this\n[hapi: private-key redacted]"],
      // JSON-escaped newlines, an indented YAML block, CRLF with trailing spaces.
      [`{"private_key": "${begin}\\n${body.join("\\n")}\\n${end}\\n"}`, '{"private_key": "[hapi: private-key redacted]\\n"}'],
      [`k: |\n  ${begin}\n${body.map((l) => `  ${l}`).join("\n")}\n  ${end}\nn: 1`, "k: |\n  [hapi: private-key redacted]\nn: 1"],
      [`${begin} \r\n${body.map((l) => `${l}  `).join("\r\n")}\r\n${end}\r\nok`, "[hapi: private-key redacted]\r\nok"],
    ].map(([text, want]) => {
      const got = redactSecrets(text!, {});
      expect(got).toBe(want!);
      return got;
    });
    for (const line of body) expect(outs.some((o) => o.includes(line))).toBe(false);
  });
});

describe("transcriptLines", () => {
  test("each row is `[<node>] <type>` and what it says; continuation lines are indented; a line that isn't JSON is named, not shown", () => {
    const text = [
      row({ type: "workflow_start", workflow_name: "hapi-check-run", content: "" }),
      row({ type: "node_start", step: "whoami", content: "<bash>" }),
      row({ type: "exec_output", step: "whoami", content: "<bash>", exit_code: 0, stdout_tail: "appuser\nuid=1001(appuser)" }),
      row({ type: "node_complete", step: "whoami", content: "<bash>", duration_ms: 16 }),
      row({ type: "node_error", step: "boom", error: "Bash node 'boom' failed [exit 42]: about to exit 42" }),
      "not json {",
      row({ type: "workflow_complete" }),
      "",
    ].join("\n");
    expect(transcriptLines(text)).toEqual([
      "[workflow] workflow_start hapi-check-run",
      "[whoami] node_start",
      "[whoami] exec_output exit 0: appuser",
      "  uid=1001(appuser)",
      "[whoami] node_complete 16 ms",
      "[boom] node_error Bash node 'boom' failed [exit 42]: about to exit 42",
      "[transcript] line 6 is not JSON: not shown",
      "[workflow] workflow_complete",
    ]);
  });
});

describe("streamLines (the host's docker logs runner)", () => {
  test("hands on each line of stdout and stderr as it comes, the last one too without a newline, and the exit code", async () => {
    const lines: string[] = [];
    const code = await streamLines(["sh", "-c", "printf 'one\\ntwo'; printf 'err\\n' >&2; exit 3"], { PATH: process.env.PATH ?? "/usr/bin:/bin" }, (l) => void lines.push(l));
    expect(code).toBe(3);
    expect(lines.sort()).toEqual(["err", "one", "two"]);
  });

  test(`a line over ${MAX_LINE_CHARS} characters is replaced whole, never cut: no part of it is shown`, async () => {
    const lines: string[] = [];
    const script = `printf 'before\\n'; head -c ${MAX_LINE_CHARS + 10} /dev/zero | tr '\\0' x; printf 'tail\\nafter\\n'`;
    expect(await streamLines(["sh", "-c", script], { PATH: process.env.PATH ?? "/usr/bin:/bin" }, (l) => void lines.push(l))).toBe(0);
    expect(lines).toEqual(["before", OVERLONG_LINE, "after"]);
  });
});

describe("hapi run watch", () => {
  test("watch redacts secret values and key formats: a live run's docker logs, then its copied transcript and its status", async () => {
    const { out } = capture();
    const key = anthropicLike();
    const f = ready();
    f.logs.push(`${ESC}[1m[probe] Started${ESC}[0m`, "", `token ${f.secret} and ${key}\r`);
    await seedRun(f, { id: ID });
    f.live.afterLogs = async () => {
      const rec = (await readRecord(f.deps.stateDir, ID))!;
      writeOut(f.deps.stateDir, ID, "transcript.jsonl", `${row({ type: "exec_output", step: "probe", exit_code: 0, stdout_tail: `saw ${f.secret}` })}\n`);
      await writeRecord(f.deps.stateDir, { ...rec, status: "succeeded" });
    };
    expect(await runWatch([ID], f.deps)).toBe(0);
    expect(out).toEqual([
      "| [probe] Started",
      "|",
      "| token [hapi: ANTHROPIC_API_KEY redacted] and [hapi: anthropic redacted]",
      "| [probe] exec_output exit 0: saw [hapi: ANTHROPIC_API_KEY redacted]",
      `run ${ID}: succeeded`,
    ]);
    expect(out.join("\n")).not.toContain(f.secret);
    expect(out.join("\n")).not.toContain(key);
  });

  test("live watch hides a private key's later lines, which docker logs hands on one at a time, up to and including its END line (ledger 168)", async () => {
    const { out } = capture();
    const f = ready();
    const body = Array.from({ length: 3 }, () => randomBytes(48).toString("base64"));
    const begin = "-----BEGIN " + "RSA PRIVATE KEY-----";
    const end = "-----END " + "RSA PRIVATE KEY-----";
    const NO_END = "[hapi: private-key redacted to the end of the text: no END line]";
    const HIDDEN = "[hapi: private-key redacted: lines hidden until its END line]";
    // A JSON-escaped key on one line holds its own END, so the normal whole-line path redacts it.
    const json = `{"private_key": "${begin}\\n${body[0]}\\n${end}\\n"}`;
    f.logs.push("[probe] Started", `key: ${begin}`, "Proc-Type: 4,ENCRYPTED", "", ...body.map((l) => `  ${l}`), `  ${end}`, "after the key", json, begin, body[0]!, "a truncated key hides the rest");
    await seedRun(f, { id: ID });
    f.live.afterLogs = async () => {
      const rec = (await readRecord(f.deps.stateDir, ID))!;
      await writeRecord(f.deps.stateDir, { ...rec, status: "succeeded" });
    };
    expect(await runWatch([ID], f.deps)).toBe(0);
    expect(out).toEqual([
      "| [probe] Started",
      `| key: ${NO_END}`,
      HIDDEN,
      "| after the key",
      '| {"private_key": "[hapi: private-key redacted]\\n"}',
      `| ${NO_END}`,
      HIDDEN,
      "(no transcript.jsonl was copied out)",
      `run ${ID}: succeeded`,
    ]);
    for (const line of body) expect(out.join("\n")).not.toContain(line);
  });

  test("a live line of 10,000 BEGIN lines is handled in one pass, not quadratically", async () => {
    const { out } = capture();
    const f = ready();
    const begin = "-----BEGIN " + "RSA PRIVATE KEY-----";
    f.logs.push(begin.repeat(10_000), "hidden", "-----END " + "RSA PRIVATE KEY----- and the rest of its line, hidden too", "shown");
    await seedRun(f, { id: ID });
    f.live.afterLogs = async () => {
      const rec = (await readRecord(f.deps.stateDir, ID))!;
      await writeRecord(f.deps.stateDir, { ...rec, status: "succeeded" });
    };
    const started = performance.now();
    expect(await runWatch([ID], f.deps)).toBe(0);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(out.slice(0, 3)).toEqual(["| [hapi: private-key redacted to the end of the text: no END line]", "[hapi: private-key redacted: lines hidden until its END line]", "| shown"]);
  });

  test("a finished run's transcript rows are sanitized and redacted too, then its status and reason", async () => {
    const { out } = capture();
    const f = ready();
    const key = githubLike();
    await seedRun(f, { id: ID, status: "failed", reason: "the workflow failed (Archon status failed)", objects: false });
    writeOut(
      f.deps.stateDir,
      ID,
      "transcript.jsonl",
      [
        row({ type: "node_start", step: `boom${ESC}]0;pwned\x07`, content: "<bash>" }),
        row({ type: "exec_output", step: "boom", exit_code: 42, stdout_tail: `${ESC}[2J${f.secret}\n${key}\x07` }),
        "",
      ].join("\n"),
    );
    expect(await runWatch([ID], f.deps)).toBe(0);
    expect(out).toEqual([
      "| [boom] node_start",
      "| [boom] exec_output exit 42: [hapi: ANTHROPIC_API_KEY redacted]",
      "|   [hapi: github-token redacted]",
      `run ${ID}: failed: the workflow failed (Archon status failed)`,
    ]);
    // No docker call for a run that has ended: its outputs are on the host.
    expect(f.calls).toEqual([]);
  });

  test("a finished run's transcript redacts a private key a row holds over several lines, body and all, and an unterminated escape takes only its own line", async () => {
    const { out } = capture();
    const f = ready();
    const body = Array.from({ length: 3 }, () => randomBytes(48).toString("base64"));
    const begin = "-----BEGIN " + "RSA PRIVATE KEY-----";
    const end = "-----END " + "RSA PRIVATE KEY-----";
    await seedRun(f, { id: ID, status: "succeeded", objects: false });
    writeOut(
      f.deps.stateDir,
      ID,
      "transcript.jsonl",
      [
        row({ type: "exec_output", step: "cat", exit_code: 0, stdout_tail: [begin, ...body, end].join("\n") }),
        row({ type: "exec_output", step: "esc", stdout_tail: `x${ESC}]0;unterminated` }),
        row({ type: "workflow_complete" }),
        "",
      ].join("\n"),
    );
    expect(await runWatch([ID], f.deps)).toBe(0);
    expect(out).toEqual([
      "| [cat] exec_output exit 0: [hapi: private-key redacted]",
      "| [esc] exec_output x",
      "| [workflow] workflow_complete",
      `run ${ID}: succeeded`,
    ]);
    for (const line of body) expect(out.join("\n")).not.toContain(line);
  });

  test("a run with no copied transcript says so", async () => {
    const { out } = capture();
    const f = ready();
    await seedRun(f, { id: ID, status: "failed", reason: "no result.json was copied out", objects: false });
    expect(await runWatch([ID], f.deps)).toBe(0);
    expect(out).toEqual(["(no transcript.jsonl was copied out)", `run ${ID}: failed: no result.json was copied out`]);
  });

  test("watch never writes to the run: only docker logs and file reads are in the recorded calls", async () => {
    capture();
    const f = ready();
    f.logs.push("[probe] Started");
    await seedRun(f, { id: ID });
    const before = treeSnapshot(f.deps.stateDir);
    let atLogsEnd: Record<string, string> = {};
    let afterFinalize: Record<string, string> = {};
    f.live.afterLogs = async () => {
      atLogsEnd = treeSnapshot(f.deps.stateDir);
      // The supervisor, not watch, finalizes the run.
      await writeRecord(f.deps.stateDir, { ...(await readRecord(f.deps.stateDir, ID))!, status: "succeeded" });
      afterFinalize = treeSnapshot(f.deps.stateDir);
    };
    expect(await runWatch([ID], f.deps)).toBe(0);
    expect(f.calls.map((c) => c.cmd)).toEqual([["docker", "logs", "--follow", N]]);
    expect(atLogsEnd).toEqual(before);
    expect(treeSnapshot(f.deps.stateDir)).toEqual(afterFinalize);
    // A run that has ended: no call at all, and nothing written.
    const done = treeSnapshot(f.deps.stateDir);
    f.calls.length = 0;
    expect(await runWatch([ID], f.deps)).toBe(0);
    expect(f.calls).toEqual([]);
    expect(treeSnapshot(f.deps.stateDir)).toEqual(done);
  });

  test("watch marks every line a run wrote with `| `, so none reads as hapi's own ending; hapi's own lines are unmarked (H-220)", async () => {
    const { out } = capture();
    const f = ready();
    const rlo = String.fromCodePoint(0x202e);
    f.logs.push(`run ${ID}: succeeded`, `${rlo}dedeecus`);
    await seedRun(f, { id: ID });
    f.live.afterLogs = async () => {
      const rec = (await readRecord(f.deps.stateDir, ID))!;
      writeOut(f.deps.stateDir, ID, "transcript.jsonl", `${row({ type: "exec_output", step: "fake", stdout_tail: `run ${ID}: succeeded` })}\n`);
      await writeRecord(f.deps.stateDir, { ...rec, status: "failed", reason: "the workflow failed (Archon status failed)" });
    };
    expect(await runWatch([ID], f.deps)).toBe(0);
    expect(out).toEqual([`| run ${ID}: succeeded`, "| dedeecus", `| [fake] exec_output run ${ID}: succeeded`, `run ${ID}: failed: the workflow failed (Archon status failed)`]);
    // The one unmarked line is hapi's, and it is the last.
    expect(out.filter((l) => !l.startsWith("|"))).toEqual([out.at(-1)!]);
  });

  test("watch redacts a review run's lines with the review zone's values too, and fails closed without review.env", async () => {
    const { out, err } = capture();
    const f = ready();
    const review = { ANTHROPIC_API_KEY: fakeSecret("REVIEW_ANTHROPIC_API_KEY"), CODERABBIT_API_KEY: fakeSecret("REVIEW_CODERABBIT_API_KEY") };
    writeZoneEnv(f.xdg, "review", review);
    f.logs.push(`live ${review.CODERABBIT_API_KEY}`);
    await seedRun(f, { id: ID, kind: "review" });
    f.live.afterLogs = async () => {
      const rec = (await readRecord(f.deps.stateDir, ID))!;
      writeOut(f.deps.stateDir, ID, "transcript.jsonl", `${row({ type: "exec_output", step: "cr", exit_code: 0, stdout_tail: `${f.secret} ${review.ANTHROPIC_API_KEY}` })}\n`);
      await writeRecord(f.deps.stateDir, { ...rec, status: "succeeded" });
    };
    expect(await runWatch([ID], f.deps)).toBe(0);
    expect(out).toEqual([
      "| live [hapi: CODERABBIT_API_KEY redacted]",
      // Both zones hold an ANTHROPIC_API_KEY, each with its own value: both are redacted, the review's named for its zone.
      "| [cr] exec_output exit 0: [hapi: ANTHROPIC_API_KEY redacted] [hapi: ANTHROPIC_API_KEY (review zone) redacted]",
      `run ${ID}: succeeded`,
    ]);
    // Without review.env, a review run's watch prints nothing of it.
    rmSync(join(f.xdg, "hapi", "env", "review.env"));
    out.length = 0;
    f.calls.length = 0;
    expect(await runWatch([ID], f.deps)).toBe(1);
    expect(out).toEqual([]);
    expect(err.at(-1)).toBe(`hapi run watch: ${join(f.xdg, "hapi", "env", "review.env")} is missing: run \`mise run up\` first`);
    expect(f.calls).toEqual([]);
    // A worker's watch needs only the archon zone's file.
    await seedRun(f, { id: "bbbbbbbbbbbb", status: "succeeded", objects: false });
    expect(await runWatch(["bbbbbbbbbbbb"], f.deps)).toBe(0);
  });

  test("watch fails closed: with no archon env file to redact with, it prints nothing of the run", async () => {
    const { out, err } = capture();
    const f = fakeRun();
    f.logs.push("[probe] Started");
    await seedRun(f, { id: ID });
    expect(await runWatch([ID], f.deps)).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual([`hapi run watch: ${join(f.xdg, "hapi", "env", "archon.env")} is missing: run \`mise run up\` first`]);
    expect(f.calls).toEqual([]);
  });

  test("a run still live after its container's log has ended is named after a bounded wait, not waited on forever", async () => {
    const { err } = capture();
    let t = NOW.getTime();
    const f = ready();
    // Each reading of the clock is a minute on: the wait gives up on its second look.
    f.deps.now = () => new Date((t += 60_000));
    await seedRun(f, { id: ID });
    expect(await runWatch([ID], f.deps)).toBe(1);
    expect(err.at(-1)).toBe(
      `hapi run watch: run ${ID}'s container has exited, but the run was not finalized within 120 s: it is still being finalized, or its supervisor died. \`hapi run list\` shows its status; \`hapi run stop ${ID}\` finalizes it if the supervisor is gone`,
    );
    expect((await readRecord(f.deps.stateDir, ID))!.status).toBe("live");
  });

  test("watch takes one run id; an unknown run is an error", async () => {
    const { err } = capture();
    const f = ready();
    for (const args of [[], [ID, ID], ["../x"], ["--follow"]]) expect(await runWatch(args, f.deps)).toBe(2);
    expect(err.every((l) => l === WATCH_USAGE)).toBe(true);
    expect(WATCH_USAGE).toBe("usage: hapi run watch <run-id>");
    err.length = 0;
    expect(await runWatch(["cccccccccccc"], f.deps)).toBe(1);
    expect(err).toEqual([`hapi run watch: there is no run cccccccccccc in ${f.deps.stateDir}`]);
    expect(f.calls).toEqual([]);
  });
});

describe("hapi run list", () => {
  test("list orders newest first: the run id, status, repo, work order, started time and spend", async () => {
    const { out } = capture();
    const f = fakeRun();
    const at = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();
    await seedRun(f, { id: "aaaaaaaaaaaa", status: "succeeded", startedAt: at(-30), repo: "/srv/a/.git", objects: false });
    await seedRun(f, { id: "cccccccccccc", status: "failed", startedAt: at(-90), repo: "/srv/c/.git", objects: false });
    await seedRun(f, { id: "bbbbbbbbbbbb", status: "live", startedAt: at(-1), repo: "/srv/b/.git", objects: false });
    writeOut(f.deps.stateDir, "aaaaaaaaaaaa", "result.json", JSON.stringify({ runs: null, run: { status: "completed", metadata: { total_cost_usd: 0.01234 } } }));
    // Not a number: no spend shown.
    writeOut(f.deps.stateDir, "cccccccccccc", "result.json", JSON.stringify({ run: { metadata: { total_cost_usd: "1e9" } } }));
    expect(await runList([], f.deps)).toBe(0);
    expect(out).toEqual([
      [
        "RUN           STATUS     REPO         WORK ORDER      STARTED                   SPEND",
        `bbbbbbbbbbbb  live       /srv/b/.git  0003-check-run  ${at(-1)}  -`,
        `aaaaaaaaaaaa  succeeded  /srv/a/.git  0003-check-run  ${at(-30)}  $0.0123`,
        `cccccccccccc  failed     /srv/c/.git  0003-check-run  ${at(-90)}  -`,
      ].join("\n"),
    ]);
    // Read only: no docker call.
    expect(f.calls).toEqual([]);
  });

  test("list's SPEND is the higher of the guard's ledger and Archon's total_cost_usd; unknown if the ledger falls; else - (H-229)", async () => {
    const { out } = capture();
    const f = fakeRun();
    const at = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();
    const spend = (usd: number) => JSON.stringify({ event: "budget", decision: "allow", rule: "spend", reason: "the run's spend so far", cost_usd: usd });
    const archon = (usd: unknown) => JSON.stringify({ run: { status: "failed", metadata: { total_cost_usd: usd } } });
    // The paid check's Run B (H-229): Archon recorded no cost, and the guard's ledger had the spend.
    await seedRun(f, { id: "aaaaaaaaaaaa", status: "failed", startedAt: at(-10), objects: false, budgetUsd: 0.0001 });
    writeOut(f.deps.stateDir, "aaaaaaaaaaaa", "decisions.jsonl", `${spend(0.0002)}\n${spend(0.0005)}\n`);
    writeOut(f.deps.stateDir, "aaaaaaaaaaaa", "result.json", JSON.stringify({ run: { status: "failed", metadata: {} } }));
    // Both: the higher.
    await seedRun(f, { id: "bbbbbbbbbbbb", status: "succeeded", startedAt: at(-20), objects: false });
    writeOut(f.deps.stateDir, "bbbbbbbbbbbb", "decisions.jsonl", `${spend(0.25)}\n`);
    writeOut(f.deps.stateDir, "bbbbbbbbbbbb", "result.json", archon(0.5));
    // A ledger that falls: unknown, whatever Archon says.
    await seedRun(f, { id: "eeeeeeeeeeee", status: "succeeded", startedAt: at(-50), objects: false });
    writeOut(f.deps.stateDir, "eeeeeeeeeeee", "decisions.jsonl", `${spend(2.75)}\n${spend(0.01)}\n`);
    writeOut(f.deps.stateDir, "eeeeeeeeeeee", "result.json", archon(2.9));
    // Archon's alone.
    await seedRun(f, { id: "cccccccccccc", status: "succeeded", startedAt: at(-30), objects: false });
    writeOut(f.deps.stateDir, "cccccccccccc", "result.json", archon(0.125));
    // Neither: -, not the budget a cap would count it at.
    await seedRun(f, { id: "dddddddddddd", status: "failed", startedAt: at(-40), objects: false, budgetUsd: 3 });
    expect(await runList([], f.deps)).toBe(0);
    expect(out[0]!.split("\n").map((l) => l.split(/\s+/).at(-1))).toEqual(["SPEND", "$0.0005", "$0.5000", "$0.1250", "-", "-"]);
  });

  test("an empty state dir lists no runs; list takes no arguments", async () => {
    const { out, err } = capture();
    const f = fakeRun();
    expect(await runList([], f.deps)).toBe(0);
    expect(out).toEqual([`no runs in ${f.deps.stateDir}`]);
    expect(await runList(["--all"], f.deps)).toBe(2);
    expect(err).toEqual([LIST_USAGE]);
    expect(LIST_USAGE).toBe("usage: hapi run list");
  });
});

describe("retention (reapRuns)", () => {
  /** A finished run's record and its dir, harvested at `harvestedAt` (if given). */
  async function finished(f: ReturnType<typeof fakeRun>, id: string, harvestedAt?: unknown): Promise<void> {
    const rec = await seedRun(f, { id, status: "succeeded", startedAt: new Date(NOW.getTime() - 400 * DAY).toISOString(), objects: false });
    await writeRecord(f.deps.stateDir, { ...rec, ...(harvestedAt === undefined ? {} : { harvestedAt }) } as RunRecord);
    writeOut(f.deps.stateDir, id, "result.json", "{}");
  }

  test("retention keeps unharvested runs, however old, and runs harvested within retention_days, or at a time that isn't one", async () => {
    capture();
    const f = fakeRun();
    await finished(f, "aaaaaaaaaaaa");
    await finished(f, "bbbbbbbbbbbb", new Date(NOW.getTime() - 13 * DAY).toISOString());
    await finished(f, "cccccccccccc", "last tuesday");
    await finished(f, "dddddddddddd", 0);
    await reapRuns(f.deps);
    for (const id of ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd"]) expect([id, existsSync(recordDir(f.deps.stateDir, id))]).toEqual([id, true]);
    expect(f.calls.filter((c) => c.cmd[0] === "docker")).toEqual([]);
  });

  test("deletes a run harvested more than retention_days ago, and says so", async () => {
    const { err } = capture();
    const f = fakeRun();
    const when = new Date(NOW.getTime() - 15 * DAY).toISOString();
    await finished(f, "aaaaaaaaaaaa", when);
    await finished(f, "bbbbbbbbbbbb");
    await reapRuns(f.deps);
    expect(existsSync(recordDir(f.deps.stateDir, "aaaaaaaaaaaa"))).toBe(false);
    expect(existsSync(recordDir(f.deps.stateDir, "bbbbbbbbbbbb"))).toBe(true);
    expect(err).toEqual([`hapi run: removed run aaaaaaaaaaaa: harvested ${when}, more than runs.retention_days (14) ago`]);
  });

  test("a live run is never deleted, harvested or not", async () => {
    capture();
    const f = fakeRun();
    const rec = await seedRun(f, { id: "aaaaaaaaaaaa", running: true });
    await writeRecord(f.deps.stateDir, { ...rec, harvestedAt: new Date(NOW.getTime() - 100 * DAY).toISOString() });
    await reapRuns(f.deps);
    expect((await readRecord(f.deps.stateDir, "aaaaaaaaaaaa"))!.status).toBe("live");
  });
});

describe("the hapi CLI", () => {
  test("registers run watch and run list, each with its usage", async () => {
    const { out, err } = capture();
    expect(await main(["--help"])).toBe(0);
    for (const name of ["run watch", "run list"]) expect(out.join("\n")).toMatch(new RegExp(`^  ${name} +\\S`, "m"));
    expect(await main(["run", "watch"])).toBe(2);
    expect(await main(["run", "list", "x"])).toBe(2);
    expect(err).toEqual([WATCH_USAGE, LIST_USAGE]);
  });
});
