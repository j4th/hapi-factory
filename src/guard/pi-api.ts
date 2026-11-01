/**
 * The subset of Pi 1.3.0's extension API that hapi-guard uses, typed by hand so
 * the bundle needs no `@earendil-works/*` package (design §3.3, "Packaging").
 * Every shape is read from the pinned image's
 * `@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` (cited `t:`)
 * and `.../core/session-manager.d.ts` (`s:`), and `@earendil-works/pi-ai/dist/types.d.ts`
 * (`a:`), as the Plan 02 research brief and spike 08 record them. Fields the guard
 * doesn't read are left out; nothing here is a value, so nothing is bundled.
 *
 * The guard registers no tools and no flags: an extension's tool would be live
 * whatever a node's `allowed_tools` says (brief §5.3), and flags can't carry
 * per-run values (§7). `registerTool` and `registerFlag` are typed only so a
 * test can assert they are never called.
 */

/** a:279-300. USD in `cost`, computed by Pi from the resolved model's prices. */
export interface Usage {
  input?: number;
  output?: number;
  cost: { total: number };
}

/** An agent message (user, assistant, toolResult, ...). Assistant and toolResult messages may carry usage. */
export interface AgentMessage {
  role: string;
  usage?: Usage;
}

/**
 * s:17-128, the entry kinds Pi's own `getUsageCostBreakdown` sums
 * (core/usage-totals.js:41-78): `message` (assistant, or toolResult with usage),
 * `usage` (cache warms), `compaction` and `branch_summary`.
 */
export interface SessionEntry {
  type: string;
  message?: AgentMessage;
  usage?: Usage;
}

/** a:624-660. The resolved model, after the catalog, the store overlay and models.json's overrides. */
export interface PiModel {
  provider: string;
  id: string;
  baseUrl: string;
  cost: unknown;
  compat?: Record<string, unknown> | null;
  maxTokens: number;
  /** Absent for every pinned model (spike 08, finding 3). */
  headers?: Record<string, string>;
}

/** t:213-253, the fields the guard reads. `sessionManager` is s:178's ReadonlySessionManager. */
export interface ExtensionContext {
  cwd: string;
  model: PiModel | undefined;
  sessionManager: {
    getEntries(): readonly SessionEntry[];
    getSessionId(): string;
  };
}

/** t:575-582. The return value is ignored; a throw fails the node (brief §2.2). */
export interface SessionStartEvent {
  type: "session_start";
  reason?: string;
}

/**
 * t:931-984. `input` is the validated args object and may be mutated in place
 * (no re-validation, t:978-983). Archon's tools are Pi's built-ins:
 * bash `{ command, timeout? }`, read `{ path, offset?, limit? }`,
 * write `{ path, content }`, edit `{ path, edits: { oldText, newText }[] }`,
 * grep, find and ls (core/tools/*.js).
 */
export interface ToolCallEvent {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** t:1089-1099. The first handler that blocks stops the rest; a throw only becomes an error result (brief §2.3). */
export interface ToolCallEventResult {
  block?: boolean;
  reason?: string;
}

export interface TextContent {
  type: "text";
  text: string;
}

/** t:985-1039. `structuredContent` is bash's `{ output, truncated, exit_code, wall_time_seconds }` (spike 08, finding 12). */
export interface ToolResultEvent {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  content: ({ type: string } & Record<string, unknown>)[];
  structuredContent?: unknown;
  isError: boolean;
}

/** t:1114-1120. Replacing `content` without returning `structuredContent` drops it. */
export interface ToolResultEventResult {
  content?: ({ type: string } & Record<string, unknown>)[];
  structuredContent?: unknown;
}

/** t:693-696. Mutating `payload` in place reaches the wire (spike 08, finding 4). */
export interface BeforeProviderRequestEvent {
  type: "before_provider_request";
  payload: unknown;
}

/** t:702-705. Fires before every send, retries and compaction summaries included (spike 08, finding 5). */
export interface BeforeProviderHeadersEvent {
  type: "before_provider_headers";
  headers: Record<string, string | null>;
}

/** t:848-851. Fires before the message is persisted to the session (agent-session.js:752-768). */
export interface MessageEndEvent {
  type: "message_end";
  message: AgentMessage;
}

/** t:828-836. By now the turn's messages are in the session's entries. */
export interface TurnEndEvent {
  type: "turn_end";
  turnIndex: number;
  message: AgentMessage;
}

export type Handler<E, R = undefined> = (event: E, ctx: ExtensionContext) => R | void | Promise<R | void>;

/** t:1186-1256, the methods the guard calls (`on`) and the two it must never call. */
export interface ExtensionAPI {
  on(event: "session_start", handler: Handler<SessionStartEvent>): unknown;
  on(event: "tool_call", handler: Handler<ToolCallEvent, ToolCallEventResult>): unknown;
  on(event: "tool_result", handler: Handler<ToolResultEvent, ToolResultEventResult>): unknown;
  on(event: "before_provider_request", handler: Handler<BeforeProviderRequestEvent, unknown>): unknown;
  on(event: "before_provider_headers", handler: Handler<BeforeProviderHeadersEvent>): unknown;
  on(event: "message_end", handler: Handler<MessageEndEvent>): unknown;
  on(event: "turn_end", handler: Handler<TurnEndEvent>): unknown;
  registerTool(tool: unknown): void;
  registerFlag(name: string, options: unknown): void;
}
