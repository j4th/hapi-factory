import { expect, test } from "bun:test";
import { FORGE_DOMAINS, forgeDomain, isHostname } from "../../src/policy/hosts";

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

test("forgeDomain ignores case, as Squid's domain matching does", () => {
  expect(forgeDomain("GitHub.com")).toBe("github.com");
  expect(forgeDomain("RAW.GitHubUserContent.COM")).toBe("githubusercontent.com");
  expect(forgeDomain("Api.Bitbucket.Org")).toBe("bitbucket.org");
});

test("isHostname is the schema's hostname: a plain, lowercase domain name", () => {
  for (const host of ["api.anthropic.com", "pypi.org", "wss-primary.slack.com", "a1.example.co.uk"]) expect(isHostname(host)).toBe(true);
  for (const host of [
    "GitHub.com", // the schema's hostname is lowercase
    "localhost", // one label
    "1.2.3.4",
    "[2001:db8::1]",
    ".slack.com",
    "slack.com.",
    "*.slack.com",
    "pypi.org:443",
    "https://pypi.org",
    "",
    " pypi.org",
    "api.anthropic.com http_access allow all",
    "api.anthropic.com\nhttp_access allow all",
    "pypi.org\r",
  ]) {
    expect(isHostname(host)).toBe(false);
  }
});
