var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/schema_and_prompt.ts
var SCHEMA_ID = "invoice_v1";
var JSON_SCHEMA = {
  name: SCHEMA_ID,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      seller: {
        type: "object",
        additionalProperties: false,
        properties: {
          company_name: { type: ["string", "null"] },
          gstin: { type: ["string", "null"] },
          address: { type: ["string", "null"] }
        },
        required: ["company_name", "gstin", "address"]
      },
      invoice: {
        type: "object",
        additionalProperties: false,
        properties: {
          number: { type: ["string", "null"] },
          date: { type: ["string", "null"] },
          // DD-MM-YYYY
          transaction_id: { type: ["string", "null"] }
        },
        required: ["number", "date", "transaction_id"]
      },
      taxes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: ["CGST", "SGST", "IGST", "CESS", "OTHER"] },
            rate_percent: { type: ["number", "null"] },
            amount: { type: ["number", "null"] }
          },
          required: ["type", "rate_percent", "amount"]
        }
      },
      amounts: {
        type: "object",
        additionalProperties: false,
        properties: {
          taxable_amount: { type: ["number", "null"] },
          total_amount: { type: ["number", "null"] }
        },
        required: ["taxable_amount", "total_amount"]
      }
    },
    required: ["seller", "invoice", "taxes", "amounts"]
  },
  strict: true
};
var SYSTEM_PROMPT = `You are an expert invoice parser for Indian GST invoices.
Return ONLY a JSON object that strictly matches the provided JSON schema.
- If a field is not present, set it to null (do not guess).
- Normalize date to DD-MM-YYYY when possible.
- 'seller.company_name' is the SELLER/ISSUER (not the buyer).
- Extract all tax lines (CGST/SGST/IGST/... with rate and amount).
- Choose the grand total for total_amount.
- No text outside the JSON.`;
var USER_INSTRUCTIONS = `Parse the attached invoice content (images) into the schema.
Prefer explicit labels; if absent, infer from layout, headers, or letterhead.
If multiple totals exist, return the grand total (post-tax). Use null for missing fields.`;

// src/worker.ts
var MODEL = "gpt-4o-mini";
function cors(h, origin) {
  h.set("Access-Control-Allow-Origin", origin ?? "*");
  h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  h.set("Access-Control-Max-Age", "86400");
}
__name(cors, "cors");
var worker_default = {
  async fetch(req, env) {
    const origin = env.ALLOWED_ORIGIN || "*";
    if (req.method === "OPTIONS") {
      const r = new Response(null, { status: 204 });
      cors(r.headers, origin);
      return r;
    }
    if (req.method !== "POST") {
      const r = new Response("Use POST /api/extract", { status: 405 });
      cors(r.headers, origin);
      return r;
    }
    try {
      const ctype = req.headers.get("content-type") || "";
      if (!ctype.includes("multipart/form-data")) {
        const r2 = new Response("Expected multipart/form-data", { status: 400 });
        cors(r2.headers, origin);
        return r2;
      }
      const form = await req.formData();
      const images = [];
      const dataurlList = form.getAll("images_dataurl[]");
      for (const v of dataurlList) {
        if (typeof v === "string" && v.startsWith("data:image/")) {
          images.push({ type: "image_url", image_url: { url: v } });
        }
      }
      const binList = form.getAll("images[]");
      for (const v of binList) {
        if (v instanceof File) {
          const buf = await v.arrayBuffer();
          const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
          const mime = v.type || "image/png";
          images.push({ type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } });
        }
      }
      if (images.length === 0) {
        const r2 = new Response("No images provided", { status: 400 });
        cors(r2.headers, origin);
        return r2;
      }
      if (images.length > 10) {
        const r2 = new Response("Max 10 pages/images allowed", { status: 400 });
        cors(r2.headers, origin);
        return r2;
      }
      const payload = {
        model: MODEL,
        messages: [
          { role: "system", content: [{ type: "text", text: SYSTEM_PROMPT }] },
          { role: "user", content: [{ type: "text", text: USER_INSTRUCTIONS }, ...images] }
        ],
        response_format: {
          type: "json_schema",
          json_schema: JSON_SCHEMA
        },
        temperature: 0
      };
      const oai = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      if (!oai.ok) {
        const errText = await oai.text();
        const r2 = new Response(`OpenAI error: ${oai.status} ${errText}`, { status: 502 });
        cors(r2.headers, origin);
        return r2;
      }
      const body = await oai.json();
      const outputText = body.output_text ?? body.output?.[0]?.content?.[0]?.text ?? body.choices?.[0]?.message?.content;
      const json = typeof outputText === "string" ? outputText : JSON.stringify(outputText);
      const r = new Response(json, { status: 200, headers: { "Content-Type": "application/json" } });
      cors(r.headers, origin);
      return r;
    } catch (e) {
      const r = new Response(`Worker error: ${e?.message ?? e}`, { status: 500 });
      cors(r.headers, env.ALLOWED_ORIGIN || "*");
      return r;
    }
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
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

// .wrangler/tmp/bundle-JkjA58/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default
];
var middleware_insertion_facade_default = worker_default;

// node_modules/wrangler/templates/middleware/common.ts
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

// .wrangler/tmp/bundle-JkjA58/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
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
