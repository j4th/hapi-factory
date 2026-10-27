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
#   6. clones hapi-factory into ~hapi/hapi-factory, owned by hapi;
#   7. prints the next steps, which run as hapi and as the operator.
set -euo pipefail

readonly HAPI_USER=hapi
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

# 5. mise, the pinned release, verified before it is installed.
ensure_mise() {
  local bin="/home/$HAPI_USER/.local/bin/mise" arch sum
  if [[ -x "$bin" ]] && sudo -iu "$HAPI_USER" -- "$bin" --version 2>/dev/null | grep -q "^$MISE_VERSION "; then
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
  install -d -o "$HAPI_USER" -g "$HAPI_USER" -m 0755 "/home/$HAPI_USER/.local" "/home/$HAPI_USER/.local/bin"
  install -o "$HAPI_USER" -g "$HAPI_USER" -m 0755 "$mise_tmp" "$bin"
  # The line is written literally: it is expanded in hapi's own shells.
  # shellcheck disable=SC2016
  local profile="/home/$HAPI_USER/.bashrc" line='eval "$(~/.local/bin/mise activate bash)"'
  grep -qxF "$line" "$profile" 2>/dev/null || printf '%s\n' "$line" >>"$profile"
  chown "$HAPI_USER:$HAPI_USER" "$profile"
  log "installed mise $MISE_VERSION for $HAPI_USER"
}

# 6. hapi's own checkout. A local path is copied (--no-local), never hardlinked to
# another user's files; root clones it, since hapi may not be able to read it.
ensure_checkout() {
  local src="$1" dest="/home/$HAPI_USER/hapi-factory"
  if [[ -d "$dest/.git" ]]; then
    log "$dest exists; to update it, as $HAPI_USER: git -C ~/hapi-factory pull"
    return
  fi
  [[ ! -e "$dest" ]] || die "$dest exists but is not a git checkout: move it away and run this again"
  if [[ -d "$src" ]]; then
    git -c safe.directory='*' clone --no-local "$src" "$dest"
  else
    git clone "$src" "$dest"
  fi
  chown -R "$HAPI_USER:$HAPI_USER" "$dest"
  log "cloned $src into $dest"
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
     operator, from your checkout:
       sudo install -d -o $HAPI_USER -g $HAPI_USER -m 0700 /home/$HAPI_USER/.config /home/$HAPI_USER/.config/hapi
       sudo install -o $HAPI_USER -g $HAPI_USER -m 0600 private/secrets.enc.yaml private/secrets.recipients.yaml private/recovery.age /home/$HAPI_USER/.config/hapi/
     As $HAPI_USER (XDG_RUNTIME_DIR exported as in step 2):
       mise run secrets:join -- --store ~/.config/hapi/secrets.enc.yaml --name $HAPI_USER
     As the operator, with the command join printed, then copy the store again:
       mise run secrets:add-machine -- --name $HAPI_USER --recipient <age1...>
       sudo install -o $HAPI_USER -g $HAPI_USER -m 0600 private/secrets.enc.yaml private/secrets.recipients.yaml private/recovery.age /home/$HAPI_USER/.config/hapi/
     As $HAPI_USER: mise run secrets:check

  4. Start the stack (from any account; it runs as $HAPI_USER):
       mise run up
EOF
}

# The download ensure_mise makes, removed however the script ends.
mise_tmp=""
trap 'rm -f "$mise_tmp"' EXIT

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
