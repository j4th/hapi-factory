/**
 * stack/compose.yaml read raw (spec §4.3): its services, merge keys resolved and
 * no profile filtered out, so the profile-only `archon` service (the run
 * container's template, Plan 02) is there for every reader. The audit reads its
 * image, build and user (src/audit/checks/{pins,tools}.ts); the launcher reads
 * the whole service and translates it into `docker run` arguments
 * (src/run/spec.ts).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { COMPOSE_FILE } from "./up";

/** A compose service: the fields the audit reads by name, and every other key as the file has it. */
export interface ComposeService {
  image?: string;
  build?: string | { context?: string; dockerfile?: string };
  pull_policy?: string;
  user?: string;
  [key: string]: unknown;
}

/** stack/compose.yaml's services, merge keys resolved. */
export async function composeServices(root: string): Promise<Record<string, ComposeService>> {
  const doc = YAML.parse(await readFile(join(root, COMPOSE_FILE), "utf8"), { merge: true }) as { services?: Record<string, ComposeService> };
  return doc.services ?? {};
}
