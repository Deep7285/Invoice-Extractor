import { JSON_SCHEMA, SYSTEM_PROMPT, USER_INSTRUCTIONS } from "./schema_and_prompt";

type Env = {
  OPENAI_API_KEY: string;
  ALLOWED_ORIGIN?: string;
};

const MODEL = "gpt-4o-mini"; // upgrade to "gpt-4o" if needed

function cors(h: Headers, origin?: string) {
  h.set("Access-Control-Allow-Origin", origin ?? "*");
  h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  h.set("Access-Control-Max-Age", "86400");
}

async function fileToDataUrlSafe(file: File): Promise<string> {
  const mime = file.type || "image/jpeg";
  const buf = new Uint8Array(await file.arrayBuffer());
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < buf.length; i += chunkSize) {
    const chunk = buf.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  const b64 = btoa(binary);
  return `data:${mime};base64,${b64}`;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
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
        const r = new Response("Expected multipart/form-data", { status: 400 });
        cors(r.headers, origin);
        return r;
      }

      const form = await req.formData();

      // 1) Optional DOCX text (extracted on the client)
      const docTextRaw = form.get("doc_text");
      const docText = typeof docTextRaw === "string" && docTextRaw.trim() ? docTextRaw.trim() : null;

      // 2) Images (PDF pages rendered client-side, or direct JPG/PNG)
      const images: Array<{ type: "image_url"; image_url: { url: string } }> = [];

      const dataurlList = form.getAll("images_dataurl[]");
      for (const v of dataurlList) {
        if (typeof v === "string" && v.startsWith("data:image/")) {
          images.push({ type: "image_url", image_url: { url: v } });
        }
      }
      const binList = form.getAll("images[]");
      for (const v of binList) {
        if (v instanceof File) {
          const dataUrl = await fileToDataUrlSafe(v);
          images.push({ type: "image_url", image_url: { url: dataUrl } });
        }
      }
      // Aliases for Postman testing
      const singleFile = form.get("file");
      if (singleFile instanceof File) {
        const dataUrl = await fileToDataUrlSafe(singleFile);
        images.push({ type: "image_url", image_url: { url: dataUrl } });
      }
      const filesArray = form.getAll("files[]");
      for (const v of filesArray) {
        if (v instanceof File) {
          const dataUrl = await fileToDataUrlSafe(v);
          images.push({ type: "image_url", image_url: { url: dataUrl } });
        }
      }

      if (!docText && images.length === 0) {
        const r = new Response("Provide at least doc_text or one image.", { status: 400 });
        cors(r.headers, origin);
        return r;
      }
      if (images.length > 10) {
        const r = new Response("Max 10 pages/images allowed", { status: 400 });
        cors(r.headers, origin);
        return r;
      }

      // Build Chat Completions payload
      const userContent: any[] = [{ type: "text", text: USER_INSTRUCTIONS }];
      if (docText) userContent.push({ type: "text", text: docText });
      if (images.length) userContent.push(...images);

      const payload = {
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent }
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: JSON_SCHEMA.name,
            schema: JSON_SCHEMA.schema,
            strict: true
          }
        },
        temperature: 0
      };

      const oai = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (!oai.ok) {
        const errText = await oai.text();
        const r = new Response(`OpenAI error: ${oai.status} ${errText}`, { status: 502 });
        cors(r.headers, origin);
        return r;
      }

      const body = await oai.json();
      const content = body?.choices?.[0]?.message?.content;
      const jsonText = typeof content === "string" ? content : JSON.stringify(content);

      const r = new Response(jsonText, { status: 200, headers: { "Content-Type": "application/json" } });
      cors(r.headers, origin);
      return r;

    } catch (e: any) {
      const r = new Response(`Worker error: ${e?.message ?? e}`, { status: 500 });
      cors(r.headers, env.ALLOWED_ORIGIN || "*");
      return r;
    }
  }
} satisfies ExportedHandler<Env>;
