/**
 * The run integration test's supervisor (./run.int.test.ts): `hapi run supervise <id>` with the throwaway
 * project's `RunDeps`, which the CLI's own supervisor can't be given: it always runs with hapi's project,
 * state dir and image. The test starts it through the host's real `spawnDetached` (src/run/cli.ts), so it
 * runs detached, in a session of its own, with its output in `<stateDir>/supervise.log`, as a real one does.
 *
 * argv: `<RunDeps fields as JSON> <run-id>`. The env is the spawner's.
 */
import { runSupervise } from "../../src/run/lifecycle";

const [fields, id] = process.argv.slice(2);
process.exitCode = await runSupervise([id ?? ""], { ...JSON.parse(fields ?? "{}"), env: process.env });
