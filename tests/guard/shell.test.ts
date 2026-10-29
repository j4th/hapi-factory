/**
 * Rule 7: a best-effort check that blocks a bash command which plainly writes to
 * a protected path. It is a signal and an early stop, not a boundary: the
 * host-side diff gate is (design §3.3 rule 7). The table below is the contract.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupAll, gatesOff, setup } from "./harness";

afterEach(cleanupAll);

/**
 * [command, blocked]. The worktree holds AGENTS.md, .github/workflows/ci.yml, .git/{objects,hooks}, src/a.ts,
 * notes.md, app.log, pkg/CLAUDE.md, node_modules/bun-types/CLAUDE.md (bun-types ships one), and the links
 * link.md -> AGENTS.md, obj -> .git/objects, wf -> .github/workflows and hook -> obj/../hooks/pre-push (dangling).
 */
const VECTORS: [string, boolean][] = [
  // Redirection: >, >>, and the fd and &> forms, attached or not.
  ["echo x > AGENTS.md", true],
  ["echo x >> AGENTS.md", true],
  ["echo x >AGENTS.md", true],
  ["echo x 2>AGENTS.md", true],
  ["echo x &>AGENTS.md", true],
  ["echo x >| .github/workflows/ci.yml", true],
  ["echo x > agents.MD", true],
  ["echo x > link.md", true],
  // A link's ".." applies after the link is followed, as the kernel does: obj/.. is .git, wf/.. is .github.
  ["echo x > obj/../hooks/pre-commit", true],
  ["echo x > wf/../workflows/evil.yml", true],
  ["echo x > hook", true],
  ["cp notes.md ./obj/../config", true],
  ["cat > AGENTS.md <<'EOF'\nhello\nEOF", true],
  // tee
  ["echo x | tee AGENTS.md", true],
  ["echo x | tee -a .github/workflows/ci.yml", true],
  // File commands, with wrappers, paths and env assignments in front.
  ["rm AGENTS.md", true],
  ["rm -rf .github", true],
  ["rm -rf .", true],
  ["rm -rf *", true],
  ["rm -rf pkg", true],
  ["X=1 /bin/rm -f AGENTS.md", true],
  ["sudo rm AGENTS.md", true],
  ["mv notes.md AGENTS.md", true],
  ["cp notes.md AGENTS.md", true],
  ["ln -sf notes.md AGENTS.md", true],
  ["chmod 000 AGENTS.md", true],
  ["chown 0 AGENTS.md", true],
  ["truncate -s 0 AGENTS.md", true],
  ["dd if=/dev/zero of=AGENTS.md count=1", true],
  ["install -m 644 notes.md AGENTS.md", true],
  ["touch AGENTS.md", true],
  ["mkdir -p .github/workflows/x", true],
  ["rmdir .github/workflows", true],
  ["unlink AGENTS.md", true],
  ["patch AGENTS.md < fix.diff", true],
  // In-place edits.
  ["sed -i s/a/b/ AGENTS.md", true],
  ["sed -ni p AGENTS.md", true],
  ["sed --in-place=.bak s/a/b/ AGENTS.md", true],
  ["perl -pi -e s/a/b/ AGENTS.md", true],
  ["perl -i.bak -pe s/a/b/ AGENTS.md", true],
  // git
  ["git config core.hooksPath x", true],
  ["git -C . config --add core.fsmonitor x", true],
  ["git apply --directory=.github fix.diff", true],
  ["git checkout -- AGENTS.md", true],
  ["git checkout HEAD -- .github/workflows/ci.yml", true],
  ["git restore AGENTS.md", true],
  ["git rm AGENTS.md", true],
  ["git rm -r --cached .", true],
  ["git mv notes.md AGENTS.md", true],
  // The working directory follows cd.
  ["cd .github && echo x > workflows/ci.yml", true],
  ["cd src; rm ../AGENTS.md", true],
  // Allowed: no write indicator, or none of them names a protected path.
  ["cat AGENTS.md", false],
  ["cat AGENTS.md | grep -n agents", false],
  ["grep -rn AGENTS.md src", false],
  ["echo x > notes.md", false],
  ["echo 'x > AGENTS.md'", false],
  ["echo \"rm AGENTS.md\"", false],
  ["echo x 2>&1 | tee notes.md", false],
  ["cat > notes.md <<EOF\nrm AGENTS.md\necho x > AGENTS.md\nEOF", false],
  ["sed s/a/b/ AGENTS.md", false],
  ["sed -n p AGENTS.md", false],
  ["perl -ne print AGENTS.md", false],
  ["perl -Mstrict -e 1 AGENTS.md", false],
  ["git config --get user.name", false],
  ["git config --list", false],
  ["git status", false],
  ["git diff AGENTS.md", false],
  ["git log -- AGENTS.md", false],
  ["git checkout -b plan/x", false],
  ["rm -f *.log", false],
  // Dependency dirs aren't walked: packages ship their own instruction files (bun-types has a CLAUDE.md).
  ["rm -rf node_modules", false],
  ["rm -rf node_modules && bun install", false],
  ["rm -rf node_modules/*", false],
  ["mv node_modules /tmp/old-modules", false],
  ["rm -rf src/tmp", false],
  ["mkdir -p src/new && touch src/new/a.ts", false],
  ["cp src/a.ts /tmp/a.ts", false],
  // The known gap: an interpreter writes past the check. Recorded, not blocked.
  ["python3 -c \"open('AGENTS.md','w')\"", false],
];

test("the vector table: each command blocks or allows as listed", async () => {
  const h = setup({ settings: gatesOff });
  writeFileSync(join(h.work, "AGENTS.md"), "# agents\n");
  mkdirSync(join(h.work, ".github", "workflows"), { recursive: true });
  writeFileSync(join(h.work, ".github", "workflows", "ci.yml"), "on: push\n");
  mkdirSync(join(h.work, "src"));
  writeFileSync(join(h.work, "src", "a.ts"), "export {};\n");
  writeFileSync(join(h.work, "notes.md"), "notes\n");
  writeFileSync(join(h.work, "app.log"), "log\n");
  mkdirSync(join(h.work, "pkg"));
  writeFileSync(join(h.work, "pkg", "CLAUDE.md"), "# pkg\n");
  mkdirSync(join(h.work, "node_modules", "bun-types"), { recursive: true });
  writeFileSync(join(h.work, "node_modules", "bun-types", "CLAUDE.md"), "# bun-types\n");
  mkdirSync(join(h.work, ".git", "objects"), { recursive: true });
  mkdirSync(join(h.work, ".git", "hooks"));
  symlinkSync("AGENTS.md", join(h.work, "link.md"));
  symlinkSync(".git/objects", join(h.work, "obj"));
  symlinkSync(".github/workflows", join(h.work, "wf"));
  symlinkSync("obj/../hooks/pre-push", join(h.work, "hook"));
  await h.start();
  const got: [string, boolean][] = [];
  for (const [command] of VECTORS) got.push([command, (await h.tool("bash", { command }))?.block === true]);
  expect(got).toEqual(VECTORS);
});

test("a block names the path and the rule; the log records it", async () => {
  const h = setup({ settings: gatesOff });
  await h.start();
  expect(await h.tool("bash", { command: "echo x > AGENTS.md" })).toEqual({
    block: true,
    reason: "hapi-guard: this command writes to the protected path AGENTS.md (rule shell-write; a best-effort check, not a boundary)",
  });
  const r = h.log().at(-1);
  expect([r.event, r.decision, r.rule, r.tool, r.path]).toEqual(["tool_call", "block", "shell-write", "bash", "AGENTS.md"]);
});

test("a shell write into Pi's agent dir, the guard's ledger or the decision log's dir blocks too", async () => {
  const h = setup({ settings: gatesOff });
  await h.start();
  expect((await h.tool("bash", { command: `echo x > ${join(h.agentDir, "AGENTS.md")}` }))?.block).toBe(true);
  expect((await h.tool("bash", { command: `rm -rf ${h.ledgerDir}` }))?.block).toBe(true);
  expect(await h.tool("bash", { command: `echo '{}' >> ${join(h.out, "decisions.jsonl")}` })).toEqual({
    block: true,
    reason: `hapi-guard: this command writes into hapi-guard's decision log dir (${h.out}) (rule shell-write; a best-effort check, not a boundary)`,
  });
  expect((await h.tool("bash", { command: `truncate -s 0 ${h.out}/decisions.jsonl` }))?.block).toBe(true);
  expect((await h.tool("bash", { command: `echo x > ${join(h.tmp, "scratch.txt")}` }))?.block).toBeUndefined();
});

test("the python one-liner is the recorded gap: the module comment and docs call rule 7 a signal, not a boundary", async () => {
  const src = await Bun.file("src/guard/shell.ts").text();
  expect(src).toContain("a signal, not a boundary");
  expect(src).toContain("python3 -c");
  expect(await Bun.file("docs/generated-configs.md").text()).toContain("a signal, not a boundary");
});
