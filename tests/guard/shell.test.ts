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

/** What every rule 7 reason ends with, inside its "(rule shell-write...)". */
const NOTE = "; a best-effort check, not a boundary; to only read a file, use the read tool";

/**
 * [command, blocked]. The worktree holds AGENTS.md, .github/workflows/ci.yml, .git/{objects,hooks}, src/a.ts,
 * notes.md, app.log, pkg/CLAUDE.md, node_modules/bun-types/CLAUDE.md (bun-types ships one), and the links
 * link.md -> AGENTS.md, obj -> .git/objects, wf -> .github/workflows and hook -> obj/../hooks/pre-push (dangling),
 * x.md, CLAUDE.md -> notes.md (a protected name over an unprotected file), and loop -> loop (a symlink loop).
 * `/tmp/stage` is the harness's /tmp: it holds .github/workflows/ci.yml, AGENTS.md and pkg/CLAUDE.md, a tree to copy in.
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
  // A protected name counts as given, not only where it points: replacing or removing CLAUDE.md changes what agents read.
  ["rm CLAUDE.md", true],
  ["ln -sf x.md CLAUDE.md", true],
  ["mv x.md CLAUDE.md", true],
  ["echo x > CLAUDE.md", true],
  ["rm -f ./CLAUDE.md", true],
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
  // cd's options are parsed; a later word is checked against every directory the command may be in (H-223(b)).
  ["cd -- .github && echo x > workflows/ci.yml", true],
  ["cd -P .github && echo x > workflows/ci.yml", true],
  ["test -d src && cd src; echo x > .github/workflows/ci.yml", true],
  ["(cd src); echo x > .github/workflows/ci.yml", true],
  ["cd src | cat; echo x > .github/workflows/ci.yml", true],
  ["cd src || true; echo x > .github/workflows/ci.yml", true],
  ["cd -x src && ls", true],
  ["cd - && ls", false],
  ["mkdir -p dist && cd dist && cp ../x.md .", false],
  // A file command counts only at the command position, and only its targets count (H-223(a)).
  ["grep -n install AGENTS.md", false],
  ["cp AGENTS.md /tmp/agents.md", false],
  ["cp -t /tmp AGENTS.md", false],
  ["dd if=AGENTS.md of=/tmp/x", false],
  ["cp --target-directory=.github/workflows notes.md", true],
  ["env rm AGENTS.md", true],
  ["find . -name x | xargs rm AGENTS.md", true],
  // The command position is past the shell's reserved words, and past a wrapper's options and their values.
  ["if true; then rm AGENTS.md; fi", true],
  ["for f in a; do rm AGENTS.md; done", true],
  ["{ rm AGENTS.md; }", true],
  ["! rm AGENTS.md", true],
  ["nohup rm AGENTS.md", true],
  ["command rm AGENTS.md", true],
  ["timeout 5 rm AGENTS.md", true],
  ["xargs -n 1 rm AGENTS.md", true],
  ["sudo -u root rm AGENTS.md", true],
  ["timeout -s KILL 5s rm AGENTS.md", true],
  ["function f { rm AGENTS.md; }", true],
  ["sudo -u root grep -rn rm AGENTS.md", false],
  ["xargs -I {} grep install {}", false],
  ["find . -name AGENTS.md -exec rm {} \\;", true],
  ["rm -- -x AGENTS.md", true],
  ["cd src > AGENTS.md", true],
  // A copy's target, and the file it makes in a target directory; ln with one operand makes ./<name>.
  ["cp src/a.ts .github/", true],
  ["cp src/a.ts pkg/CLAUDE.md", true],
  ["cp notes.md pkg", false],
  ["cp pkg/CLAUDE.md src", true],
  ["cp pkg/CLAUDE.md x2.md", false],
  ["ln -s /tmp/elsewhere/AGENTS.md", true],
  ["install -d src/x .github/y", true],
  ["sed -i -e s/a/b/ AGENTS.md", true],
  ["sed -f fix.sed -i AGENTS.md", true],
  ["cd /tmp && echo x > a.txt", false],
  // Opaque wrappers run their command in ways rule 7 can't follow: Plan 02's broad rule judges the segment.
  ["eval rm AGENTS.md", true],
  ["eval 'rm AGENTS.md'", true],
  ["watch rm AGENTS.md", true],
  ["flock /tmp/l rm AGENTS.md", true],
  ["chroot / rm AGENTS.md", true],
  ["strace rm AGENTS.md", true],
  ["fakeroot rm AGENTS.md", true],
  ["unshare rm AGENTS.md", true],
  ["coproc rm AGENTS.md", true],
  ["nsenter -t 1 rm AGENTS.md", true],
  ["su -c x; runuser rm AGENTS.md", true],
  ["parallel rm ::: AGENTS.md", true],
  ["sudo -R /x rm AGENTS.md", true],
  // find -exec's command is read as any simple command is.
  ["find . -name AGENTS.md -exec sudo rm {} \\;", true],
  ["find . -name '*.md' -exec sed -i s/a/b/ {} +", true],
  ["find . -name '*.md' -exec grep -n x {} +", false],
  // A wrapper's directory (env -C, sudo -D) runs the command there, and env -S's string is read as commands.
  ["env -C .github rm workflows/ci.yml", true],
  ["env --chdir=.github rm workflows/ci.yml", true],
  ["env --chdir .github rm workflows/ci.yml", true],
  ["env --ch=.github rm workflows/ci.yml", true],
  ["sudo -D .github rm workflows/ci.yml", true],
  ["sudo --chdir=.github rm workflows/ci.yml", true],
  ["env -S 'rm AGENTS.md'", true],
  // GNU long options by any prefix.
  ["cp --target=.github/workflows notes.md", true],
  ["cp --t .github/workflows notes.md", true],
  ["cp --targ .github/workflows notes.md", true],
  ["install --target=.github/workflows notes.md", true],
  ["ln -s --target=.github/workflows /tmp/x", true],
  ["sed -i --ex=s/a/b/ AGENTS.md", true],
  ["sed -i --expr=s/a/b/ AGENTS.md", true],
  ["sed -i --fi=fix.sed AGENTS.md", true],
  ["sed --in-pl s/a/b/ AGENTS.md", true],
  ["cp --preserve=all AGENTS.md /tmp/x", false],
  ["cp -a AGENTS.md /tmp/x", false],
  // CDPATH and OLDPWD can send a cd anywhere.
  ["CDPATH=.github; cd workflows; echo x > ci.yml", true],
  ["export CDPATH=.github && cd workflows && echo x > ci.yml", true],
  ["OLDPWD=.github; cd - && echo x > workflows/ci.yml", true],
  ["CDPATH=x; cd ./src && ls", false],
  // Copies: a trailing "/" names the same file, and a recursive copy's tree lands under its target.
  ["cp /tmp/stage/AGENTS.md/ .", true],
  ["cp -r /tmp/stage/.github/ .", true],
  ["cp -r /tmp/stage/. .", true],
  ["cp -r /tmp/stage/pkg .", true],
  ["cp -R /tmp/stage/pkg newdir", true],
  ["cp --rec /tmp/stage/pkg src", true],
  ["cp -r /tmp/stage/pkg/ /tmp/elsewhere", false],
  // A directory made earlier in the same command is a target directory.
  ["mkdir d && cp CLAUDE.md d", true],
  ["mkdir -p d/e && cp notes.md d", false],
  // An in-place edit's script is no target; a ".." after a missing dir, and a symlink loop, block (H-223(c)).
  ["sed -i 's/../X/' notes.md", false],
  ["perl -pi -e 's/../X/' notes.md", false],
  ["echo x > nothere/../x.md", true],
  ["echo x > loop", true],
  // Allowed: no write indicator, or none of them names a protected path.
  ["cat AGENTS.md", false],
  ["cat AGENTS.md | grep -n agents", false],
  ["grep -rn AGENTS.md src", false],
  ["echo x > notes.md", false],
  ["echo x >> x.md && cp x.md notes.md", false],
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
  writeFileSync(join(h.work, "x.md"), "x\n");
  symlinkSync("notes.md", join(h.work, "CLAUDE.md"));
  symlinkSync("loop", join(h.work, "loop"));
  mkdirSync(join(h.tmp, "stage", ".github", "workflows"), { recursive: true });
  writeFileSync(join(h.tmp, "stage", ".github", "workflows", "ci.yml"), "on: push\n");
  writeFileSync(join(h.tmp, "stage", "AGENTS.md"), "# staged\n");
  mkdirSync(join(h.tmp, "stage", "pkg"));
  writeFileSync(join(h.tmp, "stage", "pkg", "CLAUDE.md"), "# staged pkg\n");
  await h.start();
  const got: [string, boolean][] = [];
  for (const [command] of VECTORS) got.push([command, (await h.tool("bash", { command: command.replaceAll("/tmp/stage", join(h.tmp, "stage")) }))?.block === true]);
  expect(got).toEqual(VECTORS);
});

test("a block names the path and the rule; the log records it", async () => {
  const h = setup({ settings: gatesOff });
  await h.start();
  expect(await h.tool("bash", { command: "echo x > AGENTS.md" })).toEqual({
    block: true,
    reason: `hapi-guard: this command writes to the protected path AGENTS.md (rule shell-write${NOTE})`,
  });
  const r = h.log().at(-1);
  expect([r.event, r.decision, r.rule, r.tool, r.path]).toEqual(["tool_call", "block", "shell-write", "bash", "AGENTS.md"]);
});

test("CDPATH in the guard's env makes a relative cd unknowable, but not a ./-led one", async () => {
  const h = setup({ settings: gatesOff, env: { CDPATH: "/elsewhere" } });
  mkdirSync(join(h.work, "src"));
  await h.start();
  expect(await h.tool("bash", { command: "cd src && ls" })).toEqual({
    block: true,
    reason: `hapi-guard: this command's cd src can't be followed, so where its later words land can't be known (rule shell-write${NOTE})`,
  });
  expect(await h.tool("bash", { command: "cd ./src && ls" })).toBeUndefined();
  expect((await h.tool("bash", { command: "cd - && ls" }))?.block).toBe(true);
});

test("an option-led cd and a symlink loop block with their own reasons", async () => {
  const h = setup({ settings: gatesOff });
  symlinkSync("loop", join(h.work, "loop"));
  await h.start();
  expect(await h.tool("bash", { command: "cd -x src && ls" })).toEqual({
    block: true,
    reason: `hapi-guard: this command's cd -x can't be followed, so where its later words land can't be known (rule shell-write${NOTE})`,
  });
  expect(await h.tool("bash", { command: "echo x > loop" })).toEqual({
    block: true,
    reason: `hapi-guard: this command names loop, which goes through too many levels of symbolic links (rule shell-write${NOTE})`,
  });
  expect(await h.tool("bash", { command: "echo x > nothere/../x.md" })).toEqual({
    block: true,
    reason: `hapi-guard: this command names nothere/../x.md, which goes through ${join(h.work, "nothere")}, which doesn't exist, and then "..", so where it lands can't be known (rule shell-write${NOTE})`,
  });
});

test("a shell write into Pi's agent dir, the guard's ledger or the decision log's dir blocks too", async () => {
  const h = setup({ settings: gatesOff });
  await h.start();
  expect((await h.tool("bash", { command: `echo x > ${join(h.agentDir, "AGENTS.md")}` }))?.block).toBe(true);
  expect((await h.tool("bash", { command: `rm -rf ${h.ledgerDir}` }))?.block).toBe(true);
  expect(await h.tool("bash", { command: `echo '{}' >> ${join(h.out, "decisions.jsonl")}` })).toEqual({
    block: true,
    reason: `hapi-guard: this command writes into hapi-guard's decision log dir (${h.out}) (rule shell-write${NOTE})`,
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
