#!/usr/bin/env bash
# Give the hapi user its copy of your secrets store: the encrypted store, its
# recipients file and recovery.age, from your checkout's private/ into hapi's
# ~/.config/hapi/ (mode 0700, the files 0600). Run it as yourself, the operator,
# from your checkout (never with sudo): it reads your private/, and asks sudo for
# one thing only, to run tar as hapi. Run it again after every edit, rotation or
# recipient change; it replaces hapi's three files together.
# docs/runbooks/stack.md#3-the-hapi-users-secrets is the full procedure.
#
#   scripts/copy-secrets-to-hapi.sh
#
# Root never acts on a path inside hapi's home (docs/runbooks/stack.md#hardening).
# hapi runs the agent stack, so it is less trusted than you or root, and it may
# have planted a symlink anywhere in its home: `sudo install -o hapi ... ~hapi/...`
# would follow it as root and write or chown its target. So the three files are
# handed over as bytes on a pipe, and a process running as hapi makes the
# directory and the files. The kernel checks hapi's own permissions, so a planted
# symlink reaches only what hapi could already write.
set -euo pipefail

readonly HAPI_USER=hapi
readonly FILES=(secrets.enc.yaml secrets.recipients.yaml recovery.age)

die() {
  printf 'copy-secrets-to-hapi: error: %s\n' "$*" >&2
  exit 1
}

[[ $# -eq 0 ]] || die "it takes no arguments: run it from your checkout, whose private/ holds the store"
[[ "$(id -u)" -ne 0 ]] || die "run it as yourself, not as root: it reads your private/ and asks sudo only to run tar as $HAPI_USER"
id -u "$HAPI_USER" >/dev/null 2>&1 || die "there is no user $HAPI_USER yet: run sudo scripts/host-setup.sh first"

checkout="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for f in "${FILES[@]}"; do
  [[ -f "$checkout/private/$f" && ! -L "$checkout/private/$f" ]] || die "private/$f is missing (or not a regular file): the store, its recipients file and recovery.age go together"
done

# hapi's sh makes ~/.config/hapi (0700) and unpacks the three files there (0600: umask
# 077, and a non-root tar never keeps the archive's owner). Single quotes: hapi's sh
# expands ~, not this script.
# shellcheck disable=SC2016
tar -C "$checkout/private" -cf - -- "${FILES[@]}" |
  sudo -u "$HAPI_USER" -H -- sh -c 'umask 077
cd ~ || exit 1
mkdir -p .config/hapi && chmod 0700 .config/hapi || exit 1
tar -C .config/hapi --no-same-owner --no-same-permissions -xf -' ||
  die "$HAPI_USER could not unpack the files into its ~/.config/hapi"

printf 'copy-secrets-to-hapi: copied %s into %s'"'"'s ~/.config/hapi/\n' "${FILES[*]}" "$HAPI_USER"
