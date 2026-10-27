#!/usr/bin/env bash
# One-time host setup for hapi-factory (spec §4.3, §11.3): the dedicated `hapi`
# user, rootless Docker for it (kept running by lingering), a pinned mise, and
# hapi's own checkout of hapi-factory. The host admin runs it once, as root;
# running it again changes nothing that is already in place. No agent ever runs
# it. docs/runbooks/stack.md#1-host-setup is the full procedure.
#
#   sudo scripts/host-setup.sh [source]
#
# source: where to clone hapi-factory from, a git URL or a local path. The
# default is this checkout's `origin` remote (the GitHub remote, once it exists).
# Until then, pass this checkout's path: it is copied, not linked, and hapi can
# point its `origin` at GitHub later.
#
# What it does, each step skipped when already done:
#   1. creates the user hapi, with 1,048,576 subordinate UIDs and GIDs;
#   2. installs uidmap and the Docker rootless extras if they are missing (apt);
#   3. turns on lingering for hapi, so its systemd user manager, its
#      /run/user/<uid> (XDG_RUNTIME_DIR) and its Docker survive logout and reboot;
#   4. sets up rootless Docker for hapi (dockerd-rootless-setuptool.sh install);
#   5. installs mise for hapi, the pinned release, checked against its SHA-256;
#   6. has hapi clone hapi-factory into ~hapi/hapi-factory (a URL), or unpack a
#      copy root made (a local path);
#   7. prints the next steps, which run as hapi and as the operator.
#
# Root never acts on a path inside hapi's home: it never writes, creates, chowns
# or chmods anything there, and never tests or follows a path there. hapi runs the
# agent stack, so it is less trusted than root, and it may have planted a symlink
# anywhere in its home (~/.bashrc -> /etc/sudoers, ~/.local/bin -> /usr/local/bin),
# and this script is meant to be run again. Every step that changes hapi's home
# hands bytes to a process running as hapi (`as_hapi_sh`, reading stdin), so the
# kernel checks hapi's own permissions, and a planted symlink reaches only what
# hapi could already write. docs/runbooks/stack.md#hardening says the same.
set -euo pipefail

readonly HAPI_USER=hapi
# hapi's checkout, relative to its home (HAPI_CHECKOUT in src/stack/up.ts: where up re-execs).
readonly HAPI_CHECKOUT=hapi-factory
# Canonical's rock images (ubuntu/squid, the egress proxies) own files with uid
# 584792, beyond the 65,536 subordinate IDs useradd gives by default, and rootless
# Docker can't unpack an image with an ID it can't map. 2^20 covers it.
readonly SUBID_COUNT=1048576
# mise.toml's min_version. SHA-256s from the release's SHASUMS256.txt.
readonly MISE_VERSION=2026.10.3
readonly MISE_SHA256_X64=8d48bc510b7d844fad0bc7156c0855c2a1e7230c51e498a7f6b63b021f8b57c5
readonly MISE_SHA256_ARM64=357260e28904569a6e7124d33b65cef6d043846c07bb8f4906ddf22cc353d61d

log() { printf 'host-setup: %s\n' "$*"; }
die() {
  printf 'host-setup: error: %s\n' "$*" >&2
  exit 1
}
usage() {
  printf 'usage: sudo %s [source]\n  source: a git URL or a local path to clone hapi-factory from (default: this checkout'"'"'s origin remote)\n' "$0" >&2
}

case "${1:-}" in
  -h | --help)
    usage
    exit 0
    ;;
esac
[[ $# -le 1 ]] || {
  usage
  exit 2
}
[[ "$(id -u)" -eq 0 ]] || die "run it as root: sudo $0 [source]"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
this_checkout="$(cd "$script_dir/.." && pwd)"

# The default source: this checkout's origin remote. git runs as root on another
# user's checkout, so it is told this one directory is safe, for this call only.
default_source() {
  git -c safe.directory="$this_checkout" -C "$this_checkout" remote get-url origin 2>/dev/null ||
    die "this checkout has no origin remote yet: pass the source, e.g. sudo $0 $this_checkout"
}

# 1. The user, with a subordinate ID range wide enough for every pinned image.
ensure_user() {
  if id -u "$HAPI_USER" >/dev/null 2>&1; then
    log "user $HAPI_USER exists"
  else
    useradd --create-home --shell /bin/bash --comment "hapi-factory stack" \
      -K SUB_UID_COUNT="$SUBID_COUNT" -K SUB_GID_COUNT="$SUBID_COUNT" "$HAPI_USER"
    log "created user $HAPI_USER"
  fi
  if id -nG "$HAPI_USER" | tr ' ' '\n' | grep -qx docker; then
    die "$HAPI_USER is in the docker group, which is root on this host's rootful Docker: remove it (gpasswd -d $HAPI_USER docker) and run this again"
  fi
}

# The widest subordinate range hapi has in /etc/subuid or /etc/subgid.
widest_range() {
  awk -F: -v u="$HAPI_USER" '$1 == u && $3 > max { max = $3 } END { print max + 0 }' "$1"
}

ensure_subids() {
  local file kind
  for file in /etc/subuid /etc/subgid; do
    [[ "$(widest_range "$file")" -ge "$SUBID_COUNT" ]] && continue
    kind=uids
    [[ "$file" == /etc/subgid ]] && kind=gids
    # A fresh range above every range already handed out, in either file.
    local start
    start="$(awk -F: '{ end = $2 + $3; if (end > max) max = end } END { s = (max < 100000 ? 100000 : max); print int((s + 65535) / 65536) * 65536 }' /etc/subuid /etc/subgid)"
    usermod "--add-sub$kind" "$start-$((start + SUBID_COUNT - 1))" "$HAPI_USER"
    log "gave $HAPI_USER subordinate $kind $start-$((start + SUBID_COUNT - 1))"
  done
}

# 2. The rootless Docker prerequisites.
ensure_packages() {
  local missing=()
  command -v newuidmap >/dev/null 2>&1 || missing+=(uidmap)
  command -v dockerd-rootless-setuptool.sh >/dev/null 2>&1 || missing+=(docker-ce-rootless-extras)
  [[ -e /usr/lib/systemd/user/dbus.socket || -e /lib/systemd/user/dbus.socket ]] || missing+=(dbus-user-session)
  if [[ ${#missing[@]} -eq 0 ]]; then
    log "rootless Docker prerequisites are installed"
    return
  fi
  command -v apt-get >/dev/null 2>&1 || die "install these, then run this again: ${missing[*]}"
  log "installing ${missing[*]}"
  apt-get install -y --no-install-recommends "${missing[@]}"
}

# 3. Lingering: hapi's user manager runs without a login session.
ensure_linger() {
  loginctl enable-linger "$HAPI_USER"
  local uid i
  uid="$(id -u "$HAPI_USER")"
  for ((i = 0; i < 30; i++)); do
    [[ -d "/run/user/$uid" ]] && [[ -S "/run/user/$uid/bus" ]] && break
    sleep 1
  done
  [[ -S "/run/user/$uid/bus" ]] || die "lingering is on, but /run/user/$uid/bus did not appear: is systemd-logind running?"
  log "lingering is on for $HAPI_USER; its XDG_RUNTIME_DIR is /run/user/$uid"
}

# Run a command as hapi, in its user session (systemctl --user and its runtime dir).
# sudo -i hands the words to hapi's login shell with every `$` unescaped, so none
# of the arguments given here may hold one.
as_hapi() {
  local uid
  uid="$(id -u "$HAPI_USER")"
  sudo -iu "$HAPI_USER" -- env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" "$@"
}

# 4. Rootless Docker for hapi, as a systemd user service, with the CLI pointed at it.
ensure_rootless_docker() {
  if as_hapi systemctl --user is-active --quiet docker; then
    log "rootless Docker is running for $HAPI_USER"
  else
    as_hapi dockerd-rootless-setuptool.sh install
    as_hapi systemctl --user enable --now docker
  fi
  if as_hapi docker context inspect rootless >/dev/null 2>&1; then
    as_hapi docker context use rootless >/dev/null
  fi
  as_hapi docker info --format '{{.SecurityOptions}}' | grep -q rootless ||
    die "$HAPI_USER's docker is not the rootless daemon: check \`sudo -iu $HAPI_USER docker context ls\`"
  log "$HAPI_USER's docker is rootless"
}

# Run a shell script as hapi, in hapi's home, with hapi's HOME (-H), the rest of
# the arguments as its $1, $2, ... and this script's stdin as its stdin. sudo -u
# runs sh directly (no login shell re-reads the words), so the script and its
# arguments arrive exactly as written. The only way this script changes anything
# under hapi's home: paths in the script are relative to it, and hapi's process
# makes each change with hapi's own permissions.
as_hapi_sh() {
  local script="$1"
  shift
  sudo -u "$HAPI_USER" -H -- sh -c "cd ~ || exit 1
$script" host-setup "$@"
}

# The version line of hapi's own ~/.local/bin/mise, or nothing; checked by hapi.
hapi_mise_version() {
  as_hapi_sh '[ -x .local/bin/mise ] && exec .local/bin/mise --version' 2>/dev/null || true
}

# 5. mise, the pinned release, verified before hapi installs it. Root downloads and
# checks it in its own temp file; hapi copies it from stdin into its own
# ~/.local/bin (a temp name, then a rename: mv -T, so never into a directory that
# stands where the binary goes) and adds the activate line to its own ~/.bashrc.
ensure_mise() {
  local arch sum
  if hapi_mise_version | grep -q "^$MISE_VERSION "; then
    log "mise $MISE_VERSION is installed for $HAPI_USER"
    return
  fi
  case "$(uname -m)" in
    x86_64) arch=x64 sum="$MISE_SHA256_X64" ;;
    aarch64) arch=arm64 sum="$MISE_SHA256_ARM64" ;;
    *) die "no pinned mise for $(uname -m)" ;;
  esac
  mise_tmp="$(mktemp)"
  curl -fsSL --proto '=https' -o "$mise_tmp" "https://github.com/jdx/mise/releases/download/v$MISE_VERSION/mise-v$MISE_VERSION-linux-$arch"
  printf '%s  %s\n' "$sum" "$mise_tmp" | sha256sum -c --quiet - || die "the mise download does not match its pinned SHA-256"
  # The single quotes are deliberate: hapi's sh expands these, not this script.
  # shellcheck disable=SC2016
  as_hapi_sh 'umask 022
mkdir -p .local/bin
tmp="$(mktemp .local/bin/.mise.XXXXXX)" || exit 1
if cat >"$tmp" && chmod 0755 "$tmp" && mv -fT "$tmp" .local/bin/mise; then exit 0; fi
rm -f "$tmp"
exit 1' <"$mise_tmp" || die "$HAPI_USER could not install mise into its ~/.local/bin"
  hapi_mise_version | grep -q "^$MISE_VERSION " || die "$HAPI_USER's ~/.local/bin/mise does not report $MISE_VERSION after the install"
  # The activate line is appended by hapi, to its own ~/.bashrc, written literally:
  # hapi's shells expand it.
  # shellcheck disable=SC2016
  as_hapi_sh 'grep -qxF "$1" .bashrc 2>/dev/null || printf "%s\n" "$1" >>.bashrc' 'eval "$(~/.local/bin/mise activate bash)"' ||
    die "$HAPI_USER could not add mise's activate line to its ~/.bashrc"
  log "installed mise $MISE_VERSION for $HAPI_USER"
}

# 6. hapi's own checkout, made by hapi in a directory it creates itself: `mkdir`
# fails on any path that exists, a dangling symlink included, so nothing hapi
# planted is followed. A URL is cloned by hapi (so with hapi's own credentials: an
# SSH URL needs hapi's own key, so pass the HTTPS one). A local path, which hapi
# may not be able to read, is cloned by root into its own temp dir (--no-local:
# copied, never hardlinked to another user's files), then streamed to hapi, whose
# tar unpacks it as hapi.
ensure_checkout() {
  local src="$1"
  # shellcheck disable=SC2016
  if as_hapi_sh '[ -d "$1/.git" ]' "$HAPI_CHECKOUT"; then
    log "$HAPI_USER's checkout exists; to update it, as $HAPI_USER: git -C ~/$HAPI_CHECKOUT pull"
    return
  fi
  # shellcheck disable=SC2016
  if as_hapi_sh '[ -e "$1" ] || [ -L "$1" ]' "$HAPI_CHECKOUT"; then
    die "$HAPI_USER's ~/$HAPI_CHECKOUT exists but is not a git checkout: as $HAPI_USER, move it away, then run this again"
  fi
  if [[ -d "$src" ]]; then
    checkout_tmp="$(mktemp -d)"
    git -c safe.directory='*' clone --no-local -- "$src" "$checkout_tmp/repo"
    # shellcheck disable=SC2016
    tar -C "$checkout_tmp/repo" -cf - . | as_hapi_sh 'umask 022
mkdir -- "$1" || exit 1
if tar -C "$1" --no-same-owner -xf -; then exit 0; fi
rm -rf -- "$1"
exit 1' "$HAPI_CHECKOUT" || die "$HAPI_USER could not unpack the checkout into ~/$HAPI_CHECKOUT"
    rm -rf -- "$checkout_tmp"
    checkout_tmp=""
  else
    # shellcheck disable=SC2016
    as_hapi_sh 'umask 022
mkdir -- "$1" || exit 1
if git clone -- "$2" "$1"; then exit 0; fi
rm -rf -- "$1"
exit 1' "$HAPI_CHECKOUT" "$src" || die "$HAPI_USER could not clone $src (an SSH URL needs $HAPI_USER's own key: pass the HTTPS URL)"
  fi
  log "cloned $src into $HAPI_USER's ~/$HAPI_CHECKOUT, as $HAPI_USER"
}

next_steps() {
  local uid
  uid="$(id -u "$HAPI_USER")"
  cat <<EOF

host-setup: done. Next steps (docs/runbooks/stack.md):

  1. Check that hapi's Docker is rootless (the output contains "rootless"):
       sudo -iu $HAPI_USER docker info --format '{{.SecurityOptions}}'

  2. As $HAPI_USER, trust and install its checkout's toolchain (the secrets
     commands need the pinned age, and up refuses to start without it):
       sudo -iu $HAPI_USER
       export XDG_RUNTIME_DIR=/run/user/$uid
       cd ~/hapi-factory && mise trust && mise install && mise run setup

  3. Give $HAPI_USER its copy of the secrets store, then its own key. As the
     operator (not root), from your checkout:
       scripts/copy-secrets-to-hapi.sh
     As $HAPI_USER (XDG_RUNTIME_DIR exported as in step 2):
       mise run secrets:join -- --store ~/.config/hapi/secrets.enc.yaml --name $HAPI_USER
     As the operator, with the command join printed, then copy the store again:
       mise run secrets:add-machine -- --name $HAPI_USER --recipient <age1...>
       scripts/copy-secrets-to-hapi.sh
     As $HAPI_USER: mise run secrets:check

  4. Start the stack (from any account; it runs as $HAPI_USER):
       mise run up
EOF
}

# Root's own temp files (ensure_mise's download, ensure_checkout's clone), removed
# however the script ends.
mise_tmp=""
checkout_tmp=""
cleanup() {
  [[ -z "$mise_tmp" ]] || rm -f -- "$mise_tmp"
  [[ -z "$checkout_tmp" ]] || rm -rf -- "$checkout_tmp"
}
trap cleanup EXIT

if [[ $# -eq 1 ]]; then
  source_arg="$1"
else
  source_arg="$(default_source)" || exit 1
fi
ensure_user
ensure_subids
ensure_packages
ensure_linger
ensure_rootless_docker
ensure_mise
ensure_checkout "$source_arg"
next_steps
