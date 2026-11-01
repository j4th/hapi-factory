/**
 * `hapi run watch` and `hapi run list` (design §3.2; spike 07 findings 5 and
 * 15): the host's views of the runs it knows, one way. Neither writes to a run,
 * answers a pause or calls Archon, and no port is published (AC-13): they read
 * the run's record dir and, for a live run, `docker logs`. Both run as hapi,
 * as the other `hapi run` commands do (./lifecycle.ts `asHapi`).
 *
 * `watch <id>`:
 * - a live run: `docker logs --follow` of its container, the only live view
 *   (the transcript is in the run's `/.archon` tmpfs, out of the host's reach
 *   until copy-out). It ends when the container exits, since a stopped run's
 *   transcript has no closing row (spike 07 finding 5). Then watch waits, up to
 *   WATCH_WAIT_S, for the supervisor (or a reap) to finalize the run;
 * - then, or at once for a run that has ended: the copied `out/transcript.jsonl`,
 *   a line per row (`transcriptLines`), and how the run ended (`ended`).
 *
 * Everything a run wrote is untrusted text, so every line, live or stored,
 * goes through `sanitizeTerminal` (no escape sequence, control character or
 * bidi control reaches the terminal), then `redactSecrets` with the archon
 * zone's values, and a review run's with the review zone's too
 * (./lifecycle.ts `redactionValues`), read on the host from the env files
 * `hapi secrets resolve` wrote; a live run's lines come one at a time, so a
 * private key's later lines are hidden up to its END line (`livePrinter`).
 * Without those files, watch fails closed and prints nothing of the run.
 * Redaction sees an exact value or a key format, never an encoded or split
 * one: it keeps keys off the screen, and is no boundary. Each line a run wrote
 * is printed after `| ` (`RUN_LINE`), so none of them can pass for one of
 * hapi's own (H-220): those, the ending above all, are printed unmarked.
 *
 * `list`: every run's record, newest first, with its spend from the run's
 * copied `out/`: the higher of the guard's ledger and Archon's
 * `total_cost_usd`, or `-` when neither says it or the ledger falls
 * (./spend.ts `spendOfRun`; H-229).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { closesPrivateKey, opensPrivateKey } from "../guard/secrets";
import { definedEnv } from "../stack/up";
import { LIST_USAGE, parseRunId, WATCH_USAGE } from "./cli";
import { asHapi, ended, redactionValues } from "./lifecycle";
import { listRecords, readRecord, recordDir, type RunRecord } from "./records";
import { redactSecrets, sanitizeTerminal } from "./sanitize";
import type { RunDeps } from "./spec";
import { spendOfRun } from "./spend";

/** How long watch waits, once a live run's log has ended, for the run to be finalized (the supervisor's copy-out takes seconds). */
export const WATCH_WAIT_S = 120;

/**
 * A transcript (Archon's JSONL, spike 07) as text: `[<node>] <type>` per row (`[workflow]` for a row of no
 * node), then what the row says (the workflow's name, the exit code, the duration, the error, the output's
 * tail, other content), with each further line of it indented. A line that isn't a JSON object is named,
 * never shown. Not yet sanitized: the caller does that.
 */
export function transcriptLines(text: string): string[] {
  const out: string[] = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    let row: Record<string, unknown> | null;
    try {
      row = JSON.parse(line);
    } catch {
      row = null;
    }
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      out.push(`[transcript] line ${i + 1} is not JSON: not shown`);
      continue;
    }
    const str = (k: string) => (typeof row[k] === "string" && row[k] !== "" ? (row[k] as string) : undefined);
    const num = (k: string) => (typeof row[k] === "number" ? (row[k] as number) : undefined);
    const exit = num("exit_code");
    const ms = num("duration_ms");
    const content = str("content");
    const said = [
      str("workflow_name"),
      exit === undefined ? undefined : `exit ${exit}`,
      ms === undefined ? undefined : `${ms} ms`,
      str("error"),
      str("stdout_tail"),
      content === "<bash>" ? undefined : content,
    ].filter((s) => s !== undefined);
    const [first, ...rest] = `[${str("step") ?? "workflow"}] ${str("type") ?? "(no type)"}${said.length === 0 ? "" : ` ${said.join(": ")}`}`.split("\n");
    out.push(first!, ...rest.map((l) => `  ${l}`));
  }
  return out;
}

/** What marks a line a run wrote (H-220): an empty one is the bare mark, with no trailing space. */
export const RUN_LINE = "| ";
const marked = (line: string) => (line === "" ? RUN_LINE.trimEnd() : `${RUN_LINE}${line}`);

/**
 * A printer: each line of `text`, sanitized, then redacted with `values`, then marked as the run's (`RUN_LINE`), or,
 * for hapi's own text (`own`), unmarked. hapi's own lines go through both too: a run's ending quotes the last line
 * of its kept log.
 */
const printer = (values: Record<string, string>, own = false) => (text: string) => {
  for (const line of redactSecrets(sanitizeTerminal(text), values).split("\n")) console.log(own ? line : marked(line));
};

/** What watch prints once in place of a live private key's later lines: hapi's own line, so unmarked. */
const HIDDEN = "[hapi: private-key redacted: lines hidden until its END line]";

/**
 * The printer for a live run's `docker logs --follow`, which hands it one line at a time, so `redactSecrets` never
 * sees a private key's body beside its BEGIN line. A line that opens a key (a BEGIN line after its last END line,
 * `opensPrivateKey`) prints redacted as usual, then HIDDEN once; every later line is hidden up to and including the
 * next one that holds an END line, and past it if that line opens another key. Then printing goes on as normal; a
 * stream that ends inside a key just stops. Stdout and stderr share the one callback, so the other stream's lines
 * inside a key are hidden too.
 */
const livePrinter = (values: Record<string, string>) => {
  const print = printer(values);
  let hiding = false;
  return (line: string) => {
    const clean = sanitizeTerminal(line);
    if (hiding) {
      if (closesPrivateKey(clean)) hiding = opensPrivateKey(clean);
      return;
    }
    print(line);
    if (opensPrivateKey(clean)) {
      console.log(HIDDEN);
      hiding = true;
    }
  };
};

/** Print the run's copied transcript through `print`, marked, then how it ended through `own`, unmarked. */
async function printEnded(d: RunDeps, rec: RunRecord, print: (text: string) => void, own: (text: string) => void): Promise<void> {
  let text: string | undefined;
  try {
    text = await readFile(join(recordDir(d.stateDir, rec.runId), "out", "transcript.jsonl"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (text === undefined) own("(no transcript.jsonl was copied out)");
  // One text, so redaction sees a key a row holds over several lines, body and all (CodeRabbit, local review);
  // each line is sanitized first, so an unterminated escape sequence takes only the rest of its own line.
  else print(transcriptLines(text).map(sanitizeTerminal).join("\n"));
  own(ended(rec));
}

/** `hapi run watch <run-id>`: see the module comment. */
export async function runWatch(args: string[], deps: Partial<RunDeps> = {}): Promise<number> {
  const id = parseRunId(args);
  if (id === undefined) {
    console.error(WATCH_USAGE);
    return 2;
  }
  return asHapi("watch", args, deps, async (d) => {
    let rec = await readRecord(d.stateDir, id);
    if (rec === undefined) throw new Error(`there is no run ${id} in ${d.stateDir}`);
    // Before any line of the run is read: a zone's file that is missing fails the watch, and nothing of the run prints.
    const values = await redactionValues(d.env, rec.kind ?? "worker");
    const print = printer(values);
    const own = printer(values, true);
    if (rec.status === "live") {
      // Its exit code says nothing about the run: 0 once the container exits, 1 if it is already gone.
      await d.stream(["docker", "logs", "--follow", rec.container], definedEnv(d.env), livePrinter(values));
      const since = d.now().getTime();
      for (;;) {
        rec = (await readRecord(d.stateDir, id)) ?? rec;
        if (rec.status !== "live") break;
        if (d.now().getTime() - since >= WATCH_WAIT_S * 1000) {
          throw new Error(
            `run ${id}'s container has exited, but the run was not finalized within ${WATCH_WAIT_S} s: it is still being finalized, or its supervisor died. \`hapi run list\` shows its status; \`hapi run stop ${id}\` finalizes it if the supervisor is gone`,
          );
        }
        await Bun.sleep(1000);
      }
    }
    await printEnded(d, rec, print, own);
    return 0;
  });
}

/** `hapi run list`: every run's id, status, repo, work order, start and spend, newest first. */
export async function runList(args: string[], deps: Partial<RunDeps> = {}): Promise<number> {
  if (args.length > 0) {
    console.error(LIST_USAGE);
    return 2;
  }
  return asHapi("list", args, deps, async (d) => {
    const records = (await listRecords(d.stateDir)).sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
    if (records.length === 0) {
      console.log(`no runs in ${d.stateDir}`);
      return 0;
    }
    const rows = [["RUN", "STATUS", "REPO", "WORK ORDER", "STARTED", "SPEND"]];
    for (const r of records) {
      // The higher of the guard's ledger and Archon's; an unknown spend shows as "-", never as the budget a cap counts it at.
      const spend = spendOfRun(join(recordDir(d.stateDir, r.runId), "out"), r.budgetUsd ?? 0);
      rows.push([r.runId, r.status, r.repo, r.workOrder, r.startedAt, spend.known ? `$${spend.usd.toFixed(4)}` : "-"]);
    }
    const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
    console.log(sanitizeTerminal(rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd()).join("\n")));
    return 0;
  });
}
