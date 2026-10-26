import { expect, test } from "bun:test";
import { FORGE_DOMAINS, forgeDomain } from "../../src/policy/hosts";

test("the forge domains (spec §4.3), GitHub and the other big forges", () => {
  expect(FORGE_DOMAINS).toEqual(["github.com", "githubusercontent.com", "githubassets.com", "ghcr.io", "gitlab.com", "bitbucket.org"]);
});

test("forgeDomain names the forge a host or subdomain belongs to", () => {
  for (const d of FORGE_DOMAINS) {
    expect(forgeDomain(d)).toBe(d);
    expect(forgeDomain(`api.${d}`)).toBe(d);
    expect(forgeDomain(`a.b.${d}`)).toBe(d);
  }
});

test("look-alikes are other domains", () => {
  for (const host of ["notgithub.com", "github.com.evil.io", "githubusercontent.co", "mygitlab.com", "bitbucket.org.example", "ghcr.iox", "pypi.org"]) {
    expect(forgeDomain(host)).toBeUndefined();
  }
});
