# ten-levels-of-jev, vendored

The System One (Jev) client from `disler/ten-levels-of-jev` (MIT, see `LICENSE`), used by `src/decide/`.

- Repository: https://github.com/disler/ten-levels-of-jev
- Commit: `777adaf47d37ae0553220d35b2f15b3a3a063305`
- Path upstream: `apps/ten-levels/src/core/{client,mock,types,helpers}.ts` and `LICENSE`
- Fetched from: `https://raw.githubusercontent.com/disler/ten-levels-of-jev/777adaf47d37ae0553220d35b2f15b3a3a063305/<path>`

Never use `sharedJev()` or the `jev` proxy export: both build a client from the environment (`JEV_BACKEND`, `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`). Always construct `new JevClient({ provider, apiKey, ... })` with an explicit key.

## Files

`tests/decide/vendor.test.ts` recomputes the patched sha256s below.

| file | original sha256 | patched sha256 |
|---|---|---|
| client.ts | `ba7b3846de0a59f945928325f0882f293bdc88120dc9613f7a20326233b6cc36` | `fa30d7a38c2b2f8a2714b6d34fe148f84ef3cd37f44b55df6bc245467f31ac52` |
| mock.ts | `c4cdb85793e799573fc84a99ca5f189b3feeb25e6ba7246d402569160175720d` | `5e6c530909e28bc5c52b3dd00b8c94f741eec3a4bd0bf519c97af5e8cd19feb4` |
| types.ts | `6934e457a289f53a6c5dadd4c42fcfd7170ada6327c13c40c952d8af9a64b3de` | `6934e457a289f53a6c5dadd4c42fcfd7170ada6327c13c40c952d8af9a64b3de` |
| helpers.ts | `73c0ffd6ace85a96ec0446456d2bf94bb3a5916282cc66626e94960cd95c445c` | `73c0ffd6ace85a96ec0446456d2bf94bb3a5916282cc66626e94960cd95c445c` |
| LICENSE | `f2af63c9daec6bc7234a7d754da7266c9102308f18ac73c077903dd4bdaaaa03` | `f2af63c9daec6bc7234a7d754da7266c9102308f18ac73c077903dd4bdaaaa03` |

`types.ts`, `helpers.ts` and `LICENSE` are unpatched.

## Patches

Only these, and none changes behaviour when `fetch` is unset.

1. `client.ts` constructor: the key comes only from `opts.apiKey` (trimmed), never from `process.env[KEY_ENV[provider]]`. An unset `HAPI_JEV_OPENROUTER_API_KEY` can then never fall through to `OPENROUTER_API_KEY` (DP-8).
2. `client.ts`: `JevClientOptions` gains `fetch?: typeof fetch`, stored at construction and called as `(this.fetchImpl ?? fetch)(...)`. `decide()` passes its injected fetch and never reassigns `globalThis.fetch`, which would race between parallel gates.
3. Type errors under `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`, fixed with guards, not casts:
   - `client.ts` (`this.model`, `this.apiKey`): assigned only when defined;
   - `mock.ts` (`choiceAnswer`, `scoreAnswer`): `probs[i] ?? 0` and `entries[best]?.[0] ?? ""`. The arrays are never short (questions are validated nonempty and `probs` has one entry per option), so the values are unchanged.
