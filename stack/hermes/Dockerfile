# The Hermes container (spec §9.1): the official Hermes Agent image at the stable
# tag v0.22.5, pinned by digest (read 2026-10-26; docs/runbooks/stack.md#pinned-images).
# Built by `mise run up` (`docker compose up --build`).
#
# Nothing is added yet. Plan 04 adds hapi's own Hermes plugins and hooks here
# (hapi-path-guard, hapi-cmd-allow), so they are part of the pinned image.
#
# The image starts as root and its s6-overlay init drops to the hermes user;
# compose.yaml runs it as that user (10000) from the start instead.

FROM nousresearch/hermes-agent:v0.22.5@sha256:9c5561579f3ffdf333401797094ac3a743738d6c25d40f4331c7bf77b694238d
