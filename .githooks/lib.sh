# shellcheck shell=bash
# Shared by hapi-factory's git hooks (pre-commit, commit-msg); sourced, never run.
#
# The operator's personal strings (their name, logins and the like) live one
# per line in private/personal-strings.txt, which only the operator's clone
# has (Task 7b Step 2, H-055). They are matched as fixed strings, ignoring
# case, as whole words (grep -w): a short name must not match inside a
# longer word, as "Ash" would inside "washing". Blank lines and lines starting with # are skipped: a blank
# pattern would match every line.

PERSONAL_STRINGS="private/personal-strings.txt"

# Write the usable lines of $PERSONAL_STRINGS to a new temp file and print its
# path. Print nothing when the file doesn't exist (a clone without private/) or
# has no usable line. Exit 1 if it exists but can't be read.
personal_patterns() {
  [[ -e "$PERSONAL_STRINGS" ]] || return 0
  if [[ ! -r "$PERSONAL_STRINGS" ]]; then
    echo "${0##*/}: can't read $PERSONAL_STRINGS" >&2
    return 1
  fi
  local out
  out="$(mktemp)"
  tr -d '\r' <"$PERSONAL_STRINGS" | grep -v -e '^[[:space:]]*$' -e '^#' >"$out" || true
  if [[ ! -s "$out" ]]; then
    rm -f "$out"
    return 0
  fi
  echo "$out"
}

# The notice for a clone where there is nothing to check.
skip_notice() {
  echo "${0##*/}: no personal strings to check ($PERSONAL_STRINGS is missing or empty, as in a fresh clone); skipping that check" >&2
}
