import { expect, test } from "bun:test";
import { loadPolicy } from "../../src/policy/load";
import { applyOverlay } from "../../src/policy/overlay";
import { zoneHosts } from "../../src/policy/zones";

const p = loadPolicy("policy");

test("zoneHosts is the zone's own hosts plus its tiers' hosts, sorted and de-duplicated", () => {
  // archon lists the T1 registries itself and through tier T1: each appears once.
  expect(zoneHosts(p, "archon")).toEqual([
    "api.anthropic.com",
    "files.pythonhosted.org",
    "opencode.ai",
    "openrouter.ai",
    "pypi.org",
    "registry.npmjs.org",
  ]);
  expect(zoneHosts(p, "hermes")).toEqual([
    "api.anthropic.com",
    "api.github.com",
    "context7.com", // T2
    "deepwiki.com", // T2
    "files.pythonhosted.org", // T1
    "github.com",
    "openrouter.ai",
    "pypi.org", // T1
    "registry.npmjs.org", // T1
    "slack.com",
  ]);
});

test("zoneHosts of an open-web zone lists only its named hosts", () => {
  // research reaches any public host through openWeb; it names none itself, and T0-T3 add none beyond T1/T2.
  expect(zoneHosts(p, "research")).toEqual([
    "context7.com",
    "deepwiki.com",
    "files.pythonhosted.org",
    "pypi.org",
    "registry.npmjs.org",
  ]);
});

test("an overlay's egress_extra joins the archon allowlist", () => {
  const q = applyOverlay(p, { egress_extra: ["docs.example.org"] });
  expect(zoneHosts(q, "archon")).toContain("docs.example.org");
  expect(zoneHosts(p, "archon")).not.toContain("docs.example.org");
});
