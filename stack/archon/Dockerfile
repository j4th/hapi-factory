# The Archon container (spec §9.2, §9.3): the official Archon image at v0.12.1,
# pinned by digest, plus the toolchains Pi workers run in a target repo, baked in
# at build time so a run needs no GitHub egress (the archon zone has no forge
# route, spec §4.3): Node, uv and Python, and mise with the repo contract's tools
# (H-208), so a repo's pinned toolchain resolves offline; and CodeRabbit's CLI for
# the review's CodeRabbit step. Built by `mise run up` (`docker compose up --build`).
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
FROM jdxcode/mise:2026.10.9@sha256:07fc362c08135a926cbb1466470d9af10e89c9aa92859831c0ded2f2249bae7d AS mise

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

# mise 2026.10.9 (CI's version) and the repo contract's tools at their pins
# (templates/repo-contract/mise.toml.tmpl's [tools]; tests/stack/compose.test.ts
# holds the two equal), installed into /opt/hapi/mise at build time, read-only at
# run time (spike 09, T18). Then mise's settings for a run, image-level, never in
# the run's environment (ARCHON_ENV): trust only the clone's config, never
# download (the archon zone can't reach GitHub anyway), install only what the
# repo's mise.lock locks, and keep the shims mise rebuilds on a writable tmpfs
# (the data dir is read-only, and `mise install` fails without it). The three
# auto-installs stay on: off, `mise run` would fall back to the image's own Bun.
COPY --from=mise /usr/local/bin/mise /usr/local/bin/mise
ENV MISE_DATA_DIR=/opt/hapi/mise \
    MISE_CACHE_DIR=/opt/hapi/mise-cache
RUN mise install bun@1.4.2 gitleaks@8.30.1 osv-scanner@2.7.0 zizmor@1.31.1 && chmod -R a+rX /opt/hapi
ENV MISE_TRUSTED_CONFIG_PATHS=/work/repo \
    MISE_OFFLINE=1 \
    MISE_LOCKED=1 \
    MISE_SHIMS_DIR=/tmp/mise-shims
RUN mise --version | grep -q '^2026\.10\.9 '

# CodeRabbit's CLI 0.9.1 (factory-review's CodeRabbit step), as `cr` and
# `coderabbit`: the release's linux-x64 zip, checked against the SHA-256 in its
# SHA256SUMS, whose signature verifies with the release key in CodeRabbit's
# install script (checked 2026-11-01). The image has no unzip, so Python unpacks it.
ADD --checksum=sha256:9558e02f1b6570ade33d8191b33e10ffae2472ab2680d4518d03261bcebc80bc https://cli.coderabbit.ai/releases/0.9.1/coderabbit-linux-x64.zip /tmp/coderabbit-linux-x64.zip
RUN python3.14 -m zipfile -e /tmp/coderabbit-linux-x64.zip /opt/hapi/coderabbit \
 && rm /tmp/coderabbit-linux-x64.zip \
 && chmod 0755 /opt/hapi/coderabbit /opt/hapi/coderabbit/coderabbit \
 && ln -s /opt/hapi/coderabbit/coderabbit /usr/local/bin/coderabbit \
 && ln -s /opt/hapi/coderabbit/coderabbit /usr/local/bin/cr \
 && test "$(HOME=/tmp/coderabbit-home CODERABBIT_CLI_DISABLE_AUTO_UPDATE=1 CR_CLI_TELEMETRY_DISABLED=1 cr --version)" = 0.9.1 \
 && rm -rf /tmp/coderabbit-home

# The image's appuser; compose.yaml sets the same.
USER 1001:1001
