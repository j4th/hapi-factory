/**
 * Not a test: a child process for tests/secrets/lifecycle.test.ts ("a signal
 * releases the lock"). It runs one `hapi secrets` command (drill, recover or
 * new-recovery) with the fake tools, up to its first terminal prompt, and
 * waits there, so the test can send it SIGINT, SIGTERM or SIGHUP.
 *
 * HAPI_FIXTURE (JSON): `command`, `args`, `env` (temp HOME and
 * XDG_RUNTIME_DIR), `cwd`, `checkout`, `machineName`, and `tty`:
 * - "fake": the prompt is printed on stdout as `PROMPT <text>` and never
 *   answered;
 * - "real": the command reads /dev/tty itself (`openTerminal`), so run this
 *   under script(1), which gives it a terminal of its own.
 * It prints `PID <pid>` first. An error is printed and exits as `hapi` would.
 */
import { writeSync } from "node:fs";
import { secretsDrill, secretsNewRecovery, secretsRecover } from "../../../src/secrets/cli";
import type { Tty } from "../../../src/secrets/recovery";
import { fakeTools } from "../helpers";

const o = JSON.parse(process.env.HAPI_FIXTURE ?? "{}") as {
  command: "drill" | "recover" | "new-recovery";
  args: string[];
  env: Record<string, string>;
  cwd: string;
  checkout: string;
  machineName: string;
  tty: "fake" | "real";
};
const tools = fakeTools({ firstKey: 5000 }); // the test's own fake keys start at 100
const waitForever: Tty = {
  write: () => {},
  read(prompt) {
    writeSync(1, `PROMPT ${prompt}\n`);
    setInterval(() => {}, 1 << 30);
    return new Promise(() => {});
  },
};
const deps = {
  env: o.env,
  cwd: o.cwd,
  ageKeygen: tools.ageKeygen,
  age: tools.age,
  sops: tools.sops,
  ageDir: tools.ageDir,
  repoRoot: async () => o.checkout,
  attended: false,
  machineName: o.machineName,
  ...(o.tty === "fake" ? { tty: waitForever } : {}),
};
const run = { drill: secretsDrill, recover: secretsRecover, "new-recovery": secretsNewRecovery }[o.command];
writeSync(1, `PID ${process.pid}\n`);
try {
  process.exitCode = await run(o.args, deps);
} catch (e) {
  writeSync(2, `hapi secrets ${o.command}: ${(e as Error).message}\n`);
  const code = (e as { exitCode?: number }).exitCode;
  process.exitCode = typeof code === "number" ? code : 1;
}
