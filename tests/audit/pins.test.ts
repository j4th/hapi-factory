/**
 * pins.versions (spec §11.6): every mise.toml tool at an exact version, every
 * compose image and Dockerfile FROM (and COPY --from) by digest, the built
 * images never pulled, and every package a Dockerfile installs by name at an
 * exact version. Read from a copy of the checkout's files, so a test can
 * break one.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAudit } from "../../src/audit/index";
import { cleanup, cleanWorld, only, rootCopy } from "./helpers";

afterEach(cleanup);

async function pins(edit?: (root: string) => void) {
  const w = await cleanWorld();
  w.ctx.root = rootCopy();
  edit?.(w.ctx.root);
  return only(await runAudit(w.ctx), "pins.versions");
}
const replace = (root: string, file: string, from: string | RegExp, to: string) => {
  const path = join(root, file);
  const text = readFileSync(path, "utf8");
  const next = text.replace(from, to);
  if (next === text) throw new Error(`no ${String(from)} in ${file}`);
  writeFileSync(path, next);
};
const append = (root: string, file: string, text: string) => writeFileSync(join(root, file), readFileSync(join(root, file), "utf8") + text);

describe("pins.versions", () => {
  test("the committed mise.toml, compose.yaml and Dockerfiles pass", async () => {
    const r = await pins();
    expect(r.status).toBe("pass");
    expect(r.detail).toMatch(/\d+ mise tools, \d+ images, \d+ FROM\/COPY --from images and 1 installed package/);
  });

  test("a mise tool at latest, a range or a prefix fails, naming it", async () => {
    for (const [tool, value] of [
      ["bun", "latest"],
      ["node", "^24.22.1"],
      ["python", "3.14"],
      ["uv", "~0.13"],
      ["gh", ">=2.0.0"],
    ]) {
      const r = await pins((root) => replace(root, "mise.toml", new RegExp(`^${tool} = "[^"]+"`, "m"), `${tool} = "${value}"`));
      expect([tool, r.status]).toEqual([tool, "fail"]);
      expect(r.detail).toContain(`mise.toml: ${tool} = "${value}" is not an exact version`);
    }
  });

  test("a mise tool in table form is read by its version", async () => {
    const r = await pins((root) => replace(root, "mise.toml", /^gitleaks = "[^"]+"/m, 'gitleaks = { version = "latest" }'));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain('gitleaks = "latest"');
  });

  test("a compose image without a digest fails; so does a built service that may be pulled", async () => {
    let r = await pins((root) => replace(root, "stack/compose.yaml", /image: ubuntu\/squid:7\.2-26\.04_edge@sha256:[0-9a-f]{64}/, "image: ubuntu/squid:7.2-26.04_edge"));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("stack/compose.yaml: egress-hermes's image ubuntu/squid:7.2-26.04_edge is not pinned by digest");

    r = await pins((root) => replace(root, "stack/compose.yaml", /(image: hapi-factory\/archon:0\.12\.1\n)    pull_policy: build\n/, "$1"));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("archon is built here but has no pull_policy: build");
  });

  test("a FROM or COPY --from image without a digest fails; a FROM of an earlier stage doesn't", async () => {
    let r = await pins((root) => replace(root, "stack/hermes/Dockerfile", /@sha256:[0-9a-f]{64}/, ""));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("stack/hermes/Dockerfile: FROM nousresearch/hermes-agent:v0.22.5 is not pinned by digest");

    r = await pins((root) => append(root, "stack/archon/Dockerfile", "COPY --from=busybox:1.37 /bin/busybox /bin/busybox\n"));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("COPY --from=busybox:1.37 is not pinned by digest");

    r = await pins((root) => append(root, "stack/archon/Dockerfile", "FROM node AS again\nCOPY --from=uv /uv /tmp/uv\n"));
    expect(r.status).toBe("pass");
  });

  test("a package installed without an exact version fails; one with it passes", async () => {
    const cases: [string, "pass" | "fail", string?][] = [
      ["RUN apt-get update && apt-get install -y --no-install-recommends curl", "fail", "apt-get install curl has no version"],
      ["RUN apt-get install -y curl=8.5.0-2ubuntu10.6 \\\n    jq=1.7.1-3build1", "pass"],
      ["RUN apk add --no-cache git", "fail", "apk add git has no version"],
      ["RUN pip install --no-cache-dir requests", "fail", "pip install requests has no version"],
      ["RUN python3 -m pip install requests==2.32.3", "pass"],
      ["RUN uv pip install --system 'httpx>=0.27'", "fail", "uv pip install httpx>=0.27 has no version"],
      ["RUN uv tool install ruff==0.9.1", "pass"],
      ["RUN uv python install 3.14", "fail", "uv python install 3.14 has no version"],
      ["RUN npm install -g @anthropic-ai/claude-code", "fail", "npm install @anthropic-ai/claude-code has no version"],
      ["RUN npm i -g @scope/pkg@1.2.3 left-pad@1.3.0", "pass"],
      ["RUN npm ci", "pass"],
      ["RUN bun add zod@^4.0.0", "fail", "bun add zod@^4.0.0 has no version"],
      ["RUN DEBIAN_FRONTEND=noninteractive apt-get install -y tini", "fail", "apt-get install tini has no version"],
      ["RUN go install golang.org/x/tools/gopls@latest", "fail", "go install golang.org/x/tools/gopls@latest has no version"],
      ["RUN install -m 0755 /tmp/x /usr/local/bin/x", "pass"],
    ];
    for (const [line, status, says] of cases) {
      const r = await pins((root) => append(root, "stack/archon/Dockerfile", `${line}\n`));
      expect([line, r.status]).toEqual([line, status]);
      if (says !== undefined) expect([line, r.detail]).toEqual([line, expect.stringContaining(says)]);
    }
  });
});
