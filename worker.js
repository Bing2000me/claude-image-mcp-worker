// Image MCP (official OpenAI API) — Cloudflare Worker, single file.
// Bindings needed:
//   BUCKET          R2 bucket binding
//   OPENAI_API_KEY  secret
//   MCP_TOKEN       secret: connector request header  Authorization: Bearer <MCP_TOKEN>  (or x-api-key)
//   DOWNLOAD_SIGNING_KEY  secret: separate random key for signing download / upload links
//   DOWNLOAD_TTL_HOURS    optional text var, default 72
//   IMAGE_MODEL     optional text var: pin a model id; leave unset to auto-pick the newest gpt-image model
//   IMAGE_VARIANT   optional text var: preferred variant of the newest version, default "sunburst" (or "flare")
//   OPENAI_BASE_URL optional text var, default "https://api.openai.com/v1"

const SERVER_NAME = "image-official";
const SERVER_VERSION = "1.0.0";
const UPLOAD_TTL_SECONDS = 15 * 60;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MODEL_CACHE_MS = 60 * 60 * 1000;
let modelCache = null; // { at, models: [...] }

const INSTRUCTIONS =
  "用官方 OpenAI API 生图，默认自动使用当前最新的 gpt-image 模型，实际模型以返回为准；只有用户明确要求时才传 model。只用于需要画面质感的插画、场景、封面；" +
  "流程图、图表等精确图形不要用它。提示词尽量具体：主体、构图、风格、光线、画幅。" +
  "每张图都有一个 image_id 和带签名的下载链接，无需请求头，有效期内可重复下载（默认 72 小时，过期后用 get_image 重新取链接）；图片约 7 天后自动清理。" +
  "要给用户看图，请用 curl 下载链接里的原图再作为文件发送。" +
  "编辑用户自己的图：先调用 create_upload_url，用 curl PUT 上传（或把 browser_url 给用户在浏览器里选图），" +
  "再把返回的 image_id 传给 edit_image。不要传附件 base64。" +
  "generate_image 和 edit_image 会消耗 API 额度，不要为了试探重复生成。";

const TOOLS = [
  {
    name: "generate_image",
    description: "根据文字提示生成一张新图片，返回 image_id 和下载链接。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "具体的画面描述" },
        size: { type: "string", description: "如 1024x1024、1536x1024、1024x1536，或 auto", default: "auto" },
        quality: { type: "string", description: "low / medium / high / auto；新模型可能还支持 xhigh、max", default: "auto" },
        background: { type: "string", enum: ["auto", "opaque", "transparent"], default: "auto" },
        output_format: { type: "string", enum: ["png", "jpeg", "webp"], default: "png" },
        model: { type: "string", description: "仅在用户明确要求时填写" },
        extra_params: { type: "object", description: "原样透传给 OpenAI 的其他参数（如新模型新增的参数）" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "edit_image",
    description: "以一张或多张已有图片（之前生成的或上传的 image_id）为参考进行编辑，返回新图片。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "要怎么改" },
        image_ids: { type: "array", items: { type: "string" }, description: "参考图的 image_id 列表" },
        size: { type: "string", default: "auto" },
        quality: { type: "string", description: "low / medium / high / auto；新模型可能还支持 xhigh、max", default: "auto" },
        output_format: { type: "string", enum: ["png", "jpeg", "webp"], default: "png" },
        model: { type: "string", description: "仅在用户明确要求时填写" },
        extra_params: { type: "object", description: "原样透传给 OpenAI 的其他参数（如新模型新增的参数）" },
      },
      required: ["prompt", "image_ids"],
    },
  },
  {
    name: "create_upload_url",
    description: "预留一个 image_id 并返回上传地址：upload_url 用 curl -X PUT --data-binary 上传，browser_url 给用户在浏览器里选图。不消耗额度。",
    inputSchema: {
      type: "object",
      properties: {
        content_type: { type: "string", description: "如 image/png、image/jpeg", default: "image/png" },
      },
    },
  },
  {
    name: "list_models",
    description: "列出当前 API key 可用的 gpt-image 模型，并标出默认会用哪个。不消耗额度。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_image",
    description: "查询某个 image_id 的下载链接和信息。不生图，不消耗额度。",
    inputSchema: {
      type: "object",
      properties: { image_id: { type: "string" } },
      required: ["image_id"],
    },
  },
];

// ---------------- entry ----------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      if (parts[0] === "mcp" && parts.length === 1) {
        if (!checkAuth(request, env)) {
          // Deliberately no WWW-Authenticate header: this server does not do OAuth.
          return new Response("unauthorized", { status: 401 });
        }
        return await handleMcp(request, env, url.origin);
      }
      if (parts[0] === "img" && parts[1]) return await serveImage(request, env, url, parts[1]);
      if (parts[0] === "upload" && parts[1]) return await handleUpload(request, env, url, parts[1]);
      if (parts.length === 0 || (parts.length === 1 && parts[0] === "healthz")) {
        return new Response("image-official MCP is running.", { headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      return new Response("Not found", { status: 404 }); // incl. /.well-known/* — no OAuth metadata here
    } catch (err) {
      return new Response("Internal error: " + (err && err.message ? err.message : String(err)), { status: 500 });
    }
  },
};

// ---------------- MCP (Streamable HTTP, JSON responses) ----------------

async function handleMcp(request, env, origin) {
  if (request.method === "GET" || request.method === "DELETE") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }

  const messages = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const msg of messages) {
    const res = await handleRpc(msg, env, origin);
    if (res) responses.push(res);
  }
  if (responses.length === 0) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? responses : responses[0]);
}

async function handleRpc(msg, env, origin) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;
  if (isNotification) return null; // notifications/initialized etc.

  try {
    switch (method) {
      case "initialize":
        return ok(id, {
          protocolVersion: (params && params.protocolVersion) || "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        });
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, { tools: TOOLS });
      case "tools/call": {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        try {
          const text = await callTool(name, args, env, origin);
          return ok(id, { content: [{ type: "text", text }] });
        } catch (err) {
          return ok(id, { content: [{ type: "text", text: "出错了：" + (err.message || String(err)) }], isError: true });
        }
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } };
    }
  } catch (err) {
    return { jsonrpc: "2.0", id, error: { code: -32603, message: err.message || String(err) } };
  }
}

async function callTool(name, args, env, origin) {
  switch (name) {
    case "generate_image":
      return await generateImage(args, env, origin);
    case "edit_image":
      return await editImage(args, env, origin);
    case "create_upload_url":
      return await createUploadUrl(args, env, origin);
    case "get_image":
      return await getImage(args, env, origin);
    case "list_models":
      return await listModels(env);
    default:
      throw new Error("未知工具：" + name);
  }
}

// ---------------- tools ----------------

async function generateImage(args, env, origin) {
  if (!args.prompt) throw new Error("缺少 prompt");
  const model = await resolveModel(args, env);
  const payload = { model, prompt: args.prompt };
  for (const k of ["size", "quality", "background", "output_format"]) {
    if (args[k] && args[k] !== "auto") payload[k] = args[k];
  }
  if (args.extra_params && typeof args.extra_params === "object") Object.assign(payload, args.extra_params);
  const resp = await fetch(apiBase(env) + "/images/generations", {
    method: "POST",
    headers: { authorization: "Bearer " + env.OPENAI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return await saveOpenAIResult(resp, env, origin, model, args.output_format || "png");
}

async function editImage(args, env, origin) {
  if (!args.prompt) throw new Error("缺少 prompt");
  const ids = Array.isArray(args.image_ids) ? args.image_ids : args.image_id ? [args.image_id] : [];
  if (ids.length === 0) throw new Error("缺少 image_ids");
  const model = await resolveModel(args, env);

  const form = new FormData();
  form.append("model", model);
  form.append("prompt", args.prompt);
  for (const k of ["size", "quality", "output_format"]) {
    if (args[k] && args[k] !== "auto") form.append(k, args[k]);
  }
  if (args.extra_params && typeof args.extra_params === "object") {
    for (const [k, v] of Object.entries(args.extra_params)) {
      form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
  }
  for (const imageId of ids) {
    checkId(imageId);
    const obj = await env.BUCKET.get("images/" + imageId);
    if (!obj) throw new Error("找不到图片 " + imageId + "（可能还没上传，或已过期清理）");
    const type = (obj.httpMetadata && obj.httpMetadata.contentType) || "image/png";
    const ext = type.split("/")[1] || "png";
    form.append("image[]", new File([await obj.arrayBuffer()], imageId + "." + ext, { type }));
  }

  const resp = await fetch(apiBase(env) + "/images/edits", {
    method: "POST",
    headers: { authorization: "Bearer " + env.OPENAI_API_KEY },
    body: form,
  });
  return await saveOpenAIResult(resp, env, origin, model, args.output_format || "png");
}

async function createUploadUrl(args, env, origin) {
  const imageId = newId();
  const contentType = args.content_type || "image/png";
  const exp = Math.floor(Date.now() / 1000) + UPLOAD_TTL_SECONDS;
  const sig = await sign(env, "upload\n" + imageId + "\n" + exp);
  const q = "exp=" + exp + "&sig=" + sig;
  return [
    "已预留 image_id：" + imageId,
    "upload_url（PUT）：" + origin + "/upload/" + imageId + "?" + q,
    "curl 示例：curl -X PUT -H 'Content-Type: " + contentType + "' --data-binary @图片文件 '" + origin + "/upload/" + imageId + "?" + q + "'",
    "browser_url（给用户在浏览器里选图）：" + origin + "/upload/" + imageId + "?" + q,
    "有效期 15 分钟，只能成功上传一次。上传完成后，把 image_id 传给 edit_image。",
  ].join("\n");
}

async function getImage(args, env, origin) {
  checkId(args.image_id);
  const head = await env.BUCKET.head("images/" + args.image_id);
  if (!head) throw new Error("找不到图片 " + args.image_id + "（可能还没上传，或已过期清理）");
  const meta = head.customMetadata || {};
  return [
    "image_id：" + args.image_id,
    "下载链接：" + (await downloadUrl(env, origin, args.image_id)),
    "类型：" + ((head.httpMetadata && head.httpMetadata.contentType) || "未知"),
    "大小：" + Math.round(head.size / 1024) + " KB",
    meta.model ? "模型：" + meta.model : "",
    "上传/生成时间：" + head.uploaded.toISOString(),
  ].filter(Boolean).join("\n");
}

// ---------------- model selection ----------------

async function resolveModel(args, env) {
  if (args.model) return args.model;
  if (env.IMAGE_MODEL) return env.IMAGE_MODEL;
  const models = await fetchImageModels(env);
  if (models.length === 0) throw new Error("没有找到可用的 gpt-image 模型");
  return models[0].id;
}

// Returns gpt-image models sorted best-first: newest version, then preferred variant.
async function fetchImageModels(env) {
  if (modelCache && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.models;
  const resp = await fetch(apiBase(env) + "/models", {
    headers: { authorization: "Bearer " + env.OPENAI_API_KEY },
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(
      "无法查询模型列表（HTTP " + resp.status + "）。如果是 Restricted key，请给它加上 Models: Read 权限。" + t.slice(0, 200)
    );
  }
  const data = await resp.json();
  const prefer = (env.IMAGE_VARIANT || "sunburst").toLowerCase();
  const models = [];
  for (const m of data.data || []) {
    const match = /^gpt-image-(\d+(?:\.\d+)?)(?:-(.+))?$/.exec(m.id);
    if (!match) continue;
    const variant = match[2] || "";
    if (/\d{4}-\d{2}-\d{2}/.test(variant)) continue; // skip dated snapshots
    if (/mini|nano/.test(variant)) continue; // skip small models
    const rank = variant === prefer ? 0 : variant === "" ? 1 : 2;
    models.push({ id: m.id, version: parseFloat(match[1]), rank, created: m.created || 0 });
  }
  models.sort((a, b) => b.version - a.version || a.rank - b.rank || b.created - a.created);
  modelCache = { at: Date.now(), models };
  return models;
}

async function listModels(env) {
  const models = await fetchImageModels(env);
  const def = env.IMAGE_MODEL || (models[0] && models[0].id);
  return [
    "默认使用：" + (def || "无") + (env.IMAGE_MODEL ? "（由 IMAGE_MODEL 固定）" : "（自动选最新）"),
    "可用模型：",
    ...models.map((m) => "- " + m.id),
  ].join("\n");
}

// ---------------- helpers ----------------

async function saveOpenAIResult(resp, env, origin, model, format) {
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("OpenAI 返回了非 JSON 内容（HTTP " + resp.status + "）：" + text.slice(0, 300));
  }
  if (!resp.ok) {
    const msg = data && data.error ? data.error.message : text.slice(0, 300);
    throw new Error("OpenAI 报错（HTTP " + resp.status + "）：" + msg);
  }
  const item = data.data && data.data[0];
  if (!item || !item.b64_json) throw new Error("OpenAI 没有返回图片数据");

  let b64 = item.b64_json;
  if (b64.startsWith("data:")) b64 = b64.slice(b64.indexOf(",") + 1);
  const bytes = base64ToBytes(b64);

  const imageId = newId();
  const fmt = (data.output_format || format || "png").toLowerCase();
  const contentType = fmt === "svg" ? "image/svg+xml" : "image/" + (fmt === "jpg" ? "jpeg" : fmt);
  await env.BUCKET.put("images/" + imageId, bytes, {
    httpMetadata: { contentType },
    customMetadata: { model: data.model || model },
  });

  const lines = [
    "生成成功。",
    "image_id：" + imageId,
    "下载链接：" + (await downloadUrl(env, origin, imageId)),
    "实际使用模型：" + (data.model || model),
    "大小：" + Math.round(bytes.length / 1024) + " KB",
  ];
  if (data.size) lines.push("尺寸：" + data.size);
  if (data.quality) lines.push("质量：" + data.quality);
  if (data.usage) lines.push("用量：" + JSON.stringify(data.usage));
  return lines.join("\n");
}

async function serveImage(request, env, url, imageId) {
  const method = request.method;
  if (!isValidId(imageId)) return new Response("Not found", { status: 404 });
  if (method !== "GET" && method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const expires = parseInt(url.searchParams.get("expires") || "0", 10);
  const token = url.searchParams.get("token") || "";
  if (!expires || !safeEqual(token, await sign(env, "download\n" + imageId + "\n" + expires))) {
    return new Response("链接无效", { status: 403 });
  }
  if (expires < Date.now() / 1000) return new Response("链接已过期，请用 get_image 重新获取。", { status: 403 });
  const obj = method === "HEAD" ? await env.BUCKET.head("images/" + imageId) : await env.BUCKET.get("images/" + imageId);
  if (!obj) return new Response("Not found（可能已过期清理）", { status: 404 });
  const type = (obj.httpMetadata && obj.httpMetadata.contentType) || "application/octet-stream";
  const ext = type.split("/")[1] || "bin";
  const headers = {
    "content-type": type,
    "content-disposition": 'inline; filename="' + imageId + "." + ext + '"',
    "cache-control": "private, max-age=86400",
  };
  return new Response(method === "HEAD" ? null : obj.body, { headers });
}

async function handleUpload(request, env, url, imageId) {
  if (!isValidId(imageId)) return new Response("Not found", { status: 404 });
  const exp = parseInt(url.searchParams.get("exp") || "0", 10);
  const sig = url.searchParams.get("sig") || "";
  if (!exp || exp < Date.now() / 1000) return new Response("上传链接已过期，请重新申请。", { status: 403 });
  if (!safeEqual(sig, await sign(env, "upload\n" + imageId + "\n" + exp))) return new Response("签名无效", { status: 403 });
  if (await env.BUCKET.head("images/" + imageId)) return new Response("这个上传链接已经用过了，请重新申请。", { status: 409 });

  if (request.method === "GET") {
    return new Response(uploadPage(), { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (request.method !== "PUT" && request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const contentType = request.headers.get("content-type") || "image/png";
  if (!contentType.startsWith("image/")) return new Response("只接受图片（Content-Type 需为 image/*）", { status: 415 });
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return new Response("文件是空的", { status: 400 });
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return new Response("文件超过 20MB", { status: 413 });

  await env.BUCKET.put("images/" + imageId, bytes, {
    httpMetadata: { contentType },
    customMetadata: { source: "upload" },
  });
  return json({ ok: true, image_id: imageId, bytes: bytes.byteLength });
}

function uploadPage() {
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>上传参考图</title>
<body style="font-family:system-ui;max-width:480px;margin:48px auto;padding:0 16px">
<h2>上传参考图</h2>
<input type="file" id="f" accept="image/*"><p id="s"></p>
<script>
document.getElementById('f').onchange = async (e) => {
  const file = e.target.files[0]; if (!file) return;
  const s = document.getElementById('s'); s.textContent = '上传中…';
  const r = await fetch(location.href, { method: 'PUT', headers: { 'Content-Type': file.type || 'image/png' }, body: file });
  s.textContent = r.ok ? '上传成功，可以回到对话了。' : '上传失败：' + await r.text();
};
</script></body></html>`;
}

function base64ToBytes(b64) {
  if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function checkAuth(request, env) {
  if (!env.MCP_TOKEN || env.MCP_TOKEN.length < 24) return false;
  const auth = request.headers.get("authorization") || "";
  const given = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : request.headers.get("x-api-key") || "";
  return safeEqual(given, env.MCP_TOKEN);
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function downloadUrl(env, origin, imageId) {
  const hours = parseInt(env.DOWNLOAD_TTL_HOURS || "72", 10) || 72;
  const expires = Math.floor(Date.now() / 1000) + hours * 3600;
  const token = await sign(env, "download\n" + imageId + "\n" + expires);
  return origin + "/img/" + imageId + "?expires=" + expires + "&token=" + token;
}

async function sign(env, message) {
  if (!env.DOWNLOAD_SIGNING_KEY) throw new Error("没有设置 DOWNLOAD_SIGNING_KEY");
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.DOWNLOAD_SIGNING_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newId() {
  return crypto.randomUUID().replace(/-/g, "");
}

function isValidId(s) {
  return typeof s === "string" && /^[a-f0-9]{32}$/.test(s);
}

function checkId(s) {
  if (!isValidId(s)) throw new Error("image_id 格式不对：" + s);
}

function apiBase(env) {
  return (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
}

function ok(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
