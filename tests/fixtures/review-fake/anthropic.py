# Test only (tests/run/factory.int.test.ts): a loopback fake of the Anthropic Messages API on 127.0.0.1:18080,
# playing factory-review's review model for Claude Code (Archon 0.12.1's Claude provider), made from spike 09's
# T19 fake. No model is called and no key is real. It answers the main session with the tool calls in
# $FAKE_STEPS (a JSON list of {"name", "input"}), one per request, in order; then the schema's answer as the
# StructuredOutput tool; then "done". A request with no tools (an auxiliary call) gets a short text.
# Its log (argv[1]) never holds a key or the prompt's text: per request, the tools offered, which planted
# markers the system prompt and the messages hold, and for each tool result, the call it answers, whether it
# is an error, its first 160 characters when it is one, and which markers it holds ($FAKE_MARKERS, a JSON
# list; the key's value is among them, so a result that held it would say so without printing it).
import http.server, json, os, sys
LOG = sys.argv[1]
STEPS = json.loads(os.environ.get("FAKE_STEPS", "[]"))
MARKERS = json.loads(os.environ.get("FAKE_MARKERS", "[]"))
ANSWER = {"verdict": "needs-work", "findings": [{"severity": "minor", "path": "README.md", "summary": "fake finding"}],
          "criteria": [{"criterion": "fake criterion", "mark": "met", "evidence": "fake evidence"}]}
def text_of(x):
    if isinstance(x, str): return x
    if isinstance(x, list): return "\n".join(text_of(b) for b in x)
    if isinstance(x, dict): return text_of(x.get("text", "")) + text_of(x.get("content", ""))
    return ""
def marks(t): return [i for i, m in enumerate(MARKERS) if m in t]
def sse(events): return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()
def start(model):
    return {"type": "message_start", "message": {"id": "msg_fake", "type": "message", "role": "assistant", "model": model, "content": [],
            "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 100, "output_tokens": 1, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}}}
def text_events(model, text):
    return [start(model), {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}}, {"type": "content_block_stop", "index": 0},
            {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 100}}, {"type": "message_stop"}]
def tool_events(model, tid, name, inp):
    return [start(model), {"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": tid, "name": name, "input": {}}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": json.dumps(inp)}},
            {"type": "content_block_stop", "index": 0},
            {"type": "message_delta", "delta": {"stop_reason": "tool_use", "stop_sequence": None}, "usage": {"output_tokens": 100}}, {"type": "message_stop"}]
class H(http.server.BaseHTTPRequestHandler):
    def _log(self, rec):
        with open(LOG, "a") as f: f.write(json.dumps(rec) + "\n")
    def _send(self, code, ctype, body):
        self.send_response(code); self.send_header("content-type", ctype); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        self._log({"method": "GET"}); self._send(404, "text/plain", b"")
    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("content-length") or 0))
        try: body = json.loads(raw or b"{}")
        except Exception: body = {}
        model = body.get("model") or "claude-sonnet-5-5"
        tools = [t.get("name") for t in body.get("tools", []) if isinstance(t, dict)]
        msgs = body.get("messages", [])
        uses = {b.get("id"): b.get("name") for m in msgs if isinstance(m.get("content"), list) for b in m["content"] if isinstance(b, dict) and b.get("type") == "tool_use"}
        results = [b for m in msgs if isinstance(m.get("content"), list) for b in m["content"] if isinstance(b, dict) and b.get("type") == "tool_result"]
        rec = {"method": "POST", "tools": tools, "system_markers": marks(text_of(body.get("system", ""))),
               "message_markers": marks("\n".join(text_of(x.get("content", "")) for x in msgs if x.get("role") == "user" and isinstance(x.get("content"), str))),
               "results": [{"id": r.get("tool_use_id"), "for": uses.get(r.get("tool_use_id")), "is_error": bool(r.get("is_error")),
                            "markers": marks(text_of(r.get("content", ""))),
                            "head": text_of(r.get("content", ""))[:160] if r.get("is_error") else None} for r in results]}
        if self.path.startswith("/v1/messages/count_tokens"):
            self._log({**rec, "answer": "count_tokens"}); self._send(200, "application/json", json.dumps({"input_tokens": 100}).encode()); return
        if not self.path.startswith("/v1/messages"):
            self._log({**rec, "answer": "404"}); self._send(404, "text/plain", b""); return
        done = any(uses.get(r.get("tool_use_id")) == "StructuredOutput" for r in results)
        step = sum(1 for r in results if uses.get(r.get("tool_use_id")) != "StructuredOutput")
        if not tools: ev, answer = text_events(model, "OK"), "aux-text"
        elif done: ev, answer = text_events(model, "done"), "done"
        elif step < len(STEPS): ev, answer = tool_events(model, f"toolu_fake_{step}", STEPS[step]["name"], STEPS[step]["input"]), f"step-{step}"
        elif "StructuredOutput" in tools: ev, answer = tool_events(model, "toolu_fake_so", "StructuredOutput", ANSWER), "structured-output"
        else: ev, answer = text_events(model, json.dumps(ANSWER)), "schema-as-text"
        self._log({**rec, "answer": answer})
        if body.get("stream") is False:
            out = {"id": "msg_fake", "type": "message", "role": "assistant", "model": model, "content": [{"type": "text", "text": "OK"}],
                   "stop_reason": "end_turn", "stop_sequence": None, "usage": {"input_tokens": 100, "output_tokens": 100}}
            self._send(200, "application/json", json.dumps(out).encode()); return
        self._send(200, "text/event-stream", sse(ev))
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(("127.0.0.1", 18080), H).serve_forever()
