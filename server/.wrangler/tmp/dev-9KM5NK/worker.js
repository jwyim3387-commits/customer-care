var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var MAX_TOKENS = 4e3;
var MAX_BODY = 2 * 1024 * 1024;
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*",
      "Access-Control-Allow-Headers": "content-type,x-team-code,x-user",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Max-Age": "86400"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (env.TEAM_CODE && request.headers.get("x-team-code") !== env.TEAM_CODE) {
      return json({ error: "\uD300 \uCF54\uB4DC\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4" }, 403, cors);
    }
    try {
      if (url.pathname === "/transcribe" && request.method === "POST") return transcribe(request, env, cors);
      if (url.pathname === "/analyze" && request.method === "POST") return analyze(request, env, cors);
      if (url.pathname === "/sync" && request.method === "GET") return pull(request, env, cors);
      if (url.pathname === "/sync" && request.method === "POST") return push(request, env, cors);
      if (url.pathname === "/health") return json({ ok: true, db: !!env.DB, ai: !!env.ANTHROPIC_API_KEY, stt: !!env.AI }, 200, cors);
      return json({ error: "\uC5C6\uB294 \uC8FC\uC18C\uC785\uB2C8\uB2E4" }, 404, cors);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500, cors);
    }
  }
};
var STT_LIMIT = 24 * 1024 * 1024;
async function transcribe(request, env, cors) {
  if (!env.AI) return json({ error: "\uC11C\uBC84\uC5D0 \uC74C\uC131 \uC778\uC2DD(AI)\uC774 \uC5F0\uACB0\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4" }, 500, cors);
  const buf = new Uint8Array(await request.arrayBuffer());
  if (!buf.length) return json({ error: "\uC74C\uC131 \uD30C\uC77C\uC774 \uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4" }, 400, cors);
  if (buf.length > STT_LIMIT) {
    return json({ error: `\uD30C\uC77C\uC774 ${(buf.length / 1048576).toFixed(0)}MB \uC785\uB2C8\uB2E4. 24MB \uC774\uD558\uB85C \uB098\uB220 \uC62C\uB9AC\uAC70\uB098 \uD074\uB85C\uBC14\uB178\uD2B8\uB97C \uC4F0\uC138\uC694` }, 413, cors);
  }
  let bin = "";
  for (let i = 0; i < buf.length; i += 32768) bin += String.fromCharCode(...buf.subarray(i, i + 32768));
  const b64 = btoa(bin);
  try {
    const r = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
      audio: b64,
      task: "transcribe",
      language: "ko",
      vad_filter: "true"
    });
    const text = r && (r.text || r.transcription_info && r.transcript) || "";
    return json({ text, words: r && r.word_count, model: "whisper-large-v3-turbo" }, 200, cors);
  } catch (e) {
    try {
      const r2 = await env.AI.run("@cf/openai/whisper", { audio: [...buf] });
      return json({ text: r2 && r2.text || "", model: "whisper" }, 200, cors);
    } catch (e2) {
      return json({ error: "\uC804\uC0AC \uC2E4\uD328 : " + String(e && e.message || e).slice(0, 200) }, 502, cors);
    }
  }
}
__name(transcribe, "transcribe");
async function analyze(request, env, cors) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "\uC11C\uBC84\uC5D0 Claude \uD0A4\uAC00 \uC124\uC815\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4" }, 500, cors);
  const raw = await request.text();
  if (raw.length > 200 * 1024) return json({ error: "\uB179\uCDE8\uAC00 \uB108\uBB34 \uAE41\uB2C8\uB2E4. \uB098\uB220\uC11C \uBD84\uC11D\uD574 \uC8FC\uC138\uC694" }, 413, cors);
  const body = JSON.parse(raw);
  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: body.model || "claude-sonnet-5",
      max_tokens: Math.min(body.max_tokens || MAX_TOKENS, MAX_TOKENS),
      system: body.system,
      messages: body.messages
    })
  });
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { "content-type": "application/json", ...cors }
  });
}
__name(analyze, "analyze");
async function pull(request, env, cors) {
  if (!env.DB) return json({ error: "\uC11C\uBC84\uC5D0 \uC800\uC7A5\uC18C(D1)\uAC00 \uC5F0\uACB0\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4" }, 500, cors);
  const since = new URL(request.url).searchParams.get("since") || "";
  const rows = await env.DB.prepare(
    "SELECT kind, id, data, updated_at, deleted FROM docs WHERE updated_at > ?1 ORDER BY updated_at LIMIT 2000"
  ).bind(since).all();
  const items = (rows.results || []).map((r) => ({
    kind: r.kind,
    id: r.id,
    updatedAt: r.updated_at,
    deleted: !!r.deleted,
    data: r.deleted ? null : JSON.parse(r.data)
  }));
  return json({ now: (/* @__PURE__ */ new Date()).toISOString(), count: items.length, items }, 200, cors);
}
__name(pull, "pull");
async function push(request, env, cors) {
  if (!env.DB) return json({ error: "\uC11C\uBC84\uC5D0 \uC800\uC7A5\uC18C(D1)\uAC00 \uC5F0\uACB0\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4" }, 500, cors);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: "\uBCF4\uB0BC \uC790\uB8CC\uAC00 \uB108\uBB34 \uD07D\uB2C8\uB2E4" }, 413, cors);
  const { items = [] } = JSON.parse(raw);
  let user = (request.headers.get("x-user") || "").slice(0, 120);
  try {
    user = decodeURIComponent(user);
  } catch (e) {
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  let saved = 0, skipped = 0;
  const stmt = env.DB.prepare(
    `INSERT INTO docs (kind, id, data, updated_at, deleted, updated_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(kind, id) DO UPDATE SET
       data = excluded.data, updated_at = excluded.updated_at,
       deleted = excluded.deleted, updated_by = excluded.updated_by
     WHERE excluded.updated_at > docs.updated_at`
  );
  const batch = [];
  for (const it of items.slice(0, 1e3)) {
    if (!it || !it.kind || !it.id) {
      skipped++;
      continue;
    }
    const at = it.updatedAt || now;
    batch.push(stmt.bind(it.kind, it.id, it.deleted ? "{}" : JSON.stringify(it.data || {}), at, it.deleted ? 1 : 0, user));
    saved++;
  }
  if (batch.length) await env.DB.batch(batch);
  return json({ now, saved, skipped }, 200, cors);
}
__name(push, "push");
var json = /* @__PURE__ */ __name((obj, status, cors) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...cors } }), "json");

// ../../../AppData/Roaming/npm/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// .wrangler/tmp/bundle-404UA9/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default
];
var middleware_insertion_facade_default = worker_default;

// ../../../AppData/Roaming/npm/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-404UA9/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
