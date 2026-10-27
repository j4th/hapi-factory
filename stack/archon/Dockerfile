# The Archon container (spec §9.2, §9.3): the official Archon image at v0.12.1,
# pinned by digest, plus the toolchains Pi workers run in a target repo, baked in
# at build time so a run needs no GitHub egress (the archon zone has no forge
# route, spec §4.3). Built by `mise run up` (`docker compose up --build`).
#
# Pins (spec §11.6), each a tag and its digest, read 2026-10-26; the versions match
# mise.toml's node, uv and python. docs/runbooks/stack.md#pinned-images has them all.
#
# Pi: the image runs Archon from source, and Pi is an in-process provider there
# (`registerCommunityProviders` in @archon/providers) on the Pi SDK Archon embeds.
# The release binaries need `archon provider add pi`; this image doesn't, so the
# build checks the embedded SDK is 1.3.0 instead (spec §9.3: Pi pinned to the
# version Archon embeds).

FROM ghcr.io/astral-sh/uv:0.13.5@sha256:32a7bb39b496babbd997b0a39a4d66c126bdaf5661b302bf6f06abda8deca6ff AS uv
FROM node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea AS node

FROM ghcr.io/coleam00/archon:0.12.1@sha256:eea19d4d79420de36ecd68695e6839d4d65cc7b4f7b25a55311bcf07027cf409

USER root

# The Pi SDK Archon 0.12.1 embeds must be 1.3.0.
RUN grep -Eq '"version": *"1.3.0"' /app/node_modules/@earendil-works/pi-coding-agent/package.json \
 || { echo "the embedded Pi SDK is not 1.3.0" >&2; exit 1; }

# uv 0.13.5.
COPY --from=uv /uv /uvx /usr/local/bin/

# Node 24.22.1 and its npm, under /opt/hapi/node. The image's own `node` is Bun's
# Node shim (/usr/local/bun-node-fallback-bin), last on PATH; the real Node goes
# just before it, so the system directories keep their precedence.
COPY --from=node /usr/local/bin/node /opt/hapi/node/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /opt/hapi/node/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /opt/hapi/node/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /opt/hapi/node/bin/npx

# Python 3.14.9, installed by uv (which checks each download against the checksum
# it embeds) into /opt/hapi/python, with python3.14 in /opt/hapi/bin. At run time uv
# never downloads a Python: the archon zone can't reach the download host anyway.
ENV UV_PYTHON_INSTALL_DIR=/opt/hapi/python \
    UV_PYTHON_BIN_DIR=/opt/hapi/bin
RUN uv python install 3.14.9 && chmod -R a+rX /opt/hapi
ENV UV_PYTHON_DOWNLOADS=never \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/hapi/node/bin:/opt/hapi/bin:/usr/local/bun-node-fallback-bin

RUN test "$(node --version)" = v24.22.1 \
 && npm --version >/dev/null \
 && uv --version | grep -q '^uv 0\.13\.5' \
 && test "$(python3.14 --version)" = "Python 3.14.9"

# The image's appuser; compose.yaml sets the same.
USER 1001:1001
