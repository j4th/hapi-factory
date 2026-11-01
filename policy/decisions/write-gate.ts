/**
 * The write gate (level 6): a worker's write or edit is refused when its content
 * holds something shaped like a credential. There is no classifier here, on
 * purpose: the content being checked is the thing most likely to be a secret, so
 * it never leaves the container. A local pattern check is the whole decision.
 * Every pattern is anchored to a distinctive prefix, to keep false alarms rare.
 */
export const KEY_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: "anthropic", re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "openrouter", re: /sk-or-v1-[0-9a-f]{64}/ },
  { name: "github-token", re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: "github-pat", re: /github_pat_[A-Za-z0-9_]{50,}/ },
  { name: "slack", re: /xox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: "aws-key-id", re: /AKIA[0-9A-Z]{16}/ },
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "age-key", re: /AGE-SECRET-KEY-1[0-9A-Z]{58}/ },
];
