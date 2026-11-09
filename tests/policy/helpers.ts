/**
 * Shared by the tests that build a checkout from the real policy/: what they need of policy/repos.yaml, whatever it
 * registers by now (the sandbox since Task 16).
 */

/** The note on policy/repos.yaml's `repos:` line, as shipped. */
const REPOS_NOTE = '# "owner/name": { registered: "YYYY-MM-DD" }';

/**
 * policy/repos.yaml's text with no repo registered: `repos: {}` with its note, as shipped before Task 16, and every
 * line above it (the comments and the installations) kept. `repos:` is the file's last key.
 */
export function emptyRegistry(text: string): string {
  const at = text.search(/^repos:/m);
  if (at < 0) throw new Error("policy/repos.yaml has no repos: key");
  return `${text.slice(0, at)}repos: {}${" ".repeat(16)}${REPOS_NOTE}\n`;
}
