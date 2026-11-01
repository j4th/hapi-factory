// A test entry for bundleEntry: a Bun built-in import survives bundling, which the bundle check must refuse.
import { Database } from "bun:sqlite";

export default Database;
