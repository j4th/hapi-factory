/**
 * The model pins, H-184's runtime half and rule 4 (design §3.3, §6a item 9;
 * spike 08 findings 4, 5 and 9).
 *
 * At session_start the resolved `ctx.model` must equal its pin in
 * hapi-guard.json's `models[<provider>/<id>]` field for field: `baseUrl`, the
 * whole `cost` (tiers included), the whole `compat`, and `maxTokens`; and it has
 * no `headers`, which no pin sets (an `anthropic-beta` header would replace
 * Pi's beta list). A planted `models-store.json` can otherwise zero the cost
 * (blinding this budget and Archon's), drop compat (and with it `drop_block`)
 * or send the key to another host. A `require_compat` pin (every anthropic/*)
 * also needs `compat.supportsMidConvoEffort === true`, the flag behind
 * `drop_block` (anthropic-messages.js:886-888, 977-991).
 *
 * At before_provider_request, for every model, `max_tokens` (and
 * `max_completion_tokens`) is clamped in place to hapi-guard.json's `max_tokens`
 * and a thinking `budget_tokens` kept below it; `cache_control` is left alone, so
 * prompt caching stays on. For a `require_compat` model the payload must have
 * thinking disabled, or `thinking.block_binding.prefix_mismatch_behavior:
 * "drop_block"` with the `thinking-binding-controls-2026-08-01` beta in `betas`;
 * otherwise the node fails before the send. The top-level
 * `output_config.effort` is not checked: Pi always sends "high" there and the
 * node's effort as a trailing message (finding 4). The beta can't be checked as
 * a header: before_provider_headers sees only extra headers (finding 5).
 *
 * Compaction and branch-summary requests skip before_provider_request
 * (compaction.js:463-488), so they are neither clamped nor checked here;
 * models.json's maxTokens pin of 64000 still caps them, and
 * before_provider_headers still counts them against the budget.
 */
import { isDeepStrictEqual } from "node:util";
import type { GuardSettings, ModelPin } from "./config";
import type { PiModel } from "./pi-api";

export const BINDING_BETA = "thinking-binding-controls-2026-08-01";

export const refOf = (m: PiModel): string => `${m.provider}/${m.id}`;

/** The model's pin, or a problem. */
export function pinOf(model: PiModel | undefined, s: GuardSettings): { ref: string; pin: ModelPin } | { problem: string } {
  if (!model) return { problem: "the session has no model" };
  const ref = refOf(model);
  const pin = Object.hasOwn(s.models, ref) ? s.models[ref] : undefined;
  return pin ? { ref, pin } : { problem: `${ref} has no pin in hapi-guard.json's models` };
}

/** Why the resolved model doesn't match its pin, or undefined when it does. */
export function modelProblem(model: PiModel | undefined, s: GuardSettings): string | undefined {
  const found = pinOf(model, s);
  if ("problem" in found) return found.problem;
  const { ref, pin } = found;
  const m = model!;
  if (pin.require_compat && m.compat?.supportsMidConvoEffort !== true) {
    return `${ref} resolved without compat.supportsMidConvoEffort, so Pi won't send drop_block (H-184)`;
  }
  if (m.baseUrl !== pin.base_url) return `${ref}: baseUrl is ${JSON.stringify(m.baseUrl)}, not the pinned ${JSON.stringify(pin.base_url)}`;
  if (!isDeepStrictEqual(m.cost, pin.cost)) return `${ref}: cost differs from the pin`;
  if (!isDeepStrictEqual(m.compat ?? null, pin.compat)) return `${ref}: compat differs from the pin`;
  if (m.maxTokens !== pin.max_tokens) return `${ref}: maxTokens is ${JSON.stringify(m.maxTokens)}, not the pinned ${pin.max_tokens}`;
  if (m.headers !== undefined && Object.keys(m.headers).length > 0) return `${ref} has headers, which no pin sets`;
  return undefined;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Clamp the payload's output-token fields in place; returns what changed, as a log reason, or undefined. */
export function clamp(payload: Obj, max: number): string | undefined {
  const changed: string[] = [];
  for (const field of ["max_tokens", "max_completion_tokens"]) {
    const v = payload[field];
    if (typeof v === "number" && v > max) {
      payload[field] = max;
      changed.push(`${field} ${v} clamped to ${max}`);
    }
  }
  const thinking = payload.thinking;
  const cap = typeof payload.max_tokens === "number" ? payload.max_tokens : max;
  if (isObj(thinking) && typeof thinking.budget_tokens === "number" && thinking.budget_tokens >= cap) {
    changed.push(`thinking.budget_tokens ${thinking.budget_tokens} clamped to ${cap - 1}`);
    thinking.budget_tokens = cap - 1;
  }
  return changed.length > 0 ? changed.join("; ") : undefined;
}

/** H-184 on the outgoing payload: thinking off, or drop_block with the binding beta. */
export function bindsThinking(payload: Obj): boolean {
  const thinking = isObj(payload.thinking) ? payload.thinking : undefined;
  if (thinking?.type === "disabled") return true;
  const binding = isObj(thinking?.block_binding) ? thinking.block_binding : undefined;
  return binding?.prefix_mismatch_behavior === "drop_block" && Array.isArray(payload.betas) && payload.betas.includes(BINDING_BETA);
}

export const isPayload = isObj;
