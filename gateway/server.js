/**
 * 极简本地网关：OpenAI 兼容接口 -> 本地 ComfyUI
 * 零第三方依赖，Node 18+ 直接运行
 *
 * 提供：
 *   GET  /v1/models                    模型列表（图片 + 视频）
 *   POST /v1/images/generations        文生图（Qwen Image 2.1 t2i）
 *   POST /v1/images/edits              图生图/参考图编辑（Qwen Image 2.1 edit）
 *   POST /v1/videos                    文生视频（MiniMax H3）-- 异步提交
 *   GET  /v1/videos/{id}               查询视频任务状态
 *   GET  /v1/videos/{id}/content       下载生成的 MP4
 *   GET  /system/stats                 系统内存/显存占用（画布顶栏）
 *   POST /system/free                  卸载模型、释放显存（画布顶栏一键清理）
 *   GET  /version                      返回本地 VERSION（画布版本更新弹窗）
 *   GET  /changelog                    返回本地 CHANGELOG.md（画布版本更新弹窗）
 *
 * 启动：node gateway/server.js
 * 端口：8190（可用 PORT 环境变量覆盖）
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMFY = process.env.COMFY_URL || "http://127.0.0.1:8188";
const PORT = Number(process.env.PORT || 8190);
const MODEL_ID = "image-qwen21";
const VIDEO_MODEL_ID = "video-minimax-h3";
const T2I_WORKFLOW = path.join(__dirname, "qwen-t2i.json");
const EDIT_WORKFLOW = path.join(__dirname, "qwen-edit.json");
const VIDEO_WORKFLOW = path.join(__dirname, "h3-t2v.json");
const VIDEO_OUT_DIR = path.join(__dirname, "video-outputs");
const PROJECT_ROOT = path.resolve(__dirname, "..");
const VERSION_FILE = path.join(PROJECT_ROOT, "VERSION");
const CHANGELOG_FILE = path.join(PROJECT_ROOT, "CHANGELOG.md");
try { fs.mkdirSync(VIDEO_OUT_DIR, { recursive: true }); } catch {}
// 视频任务表：id -> { status, created, file, error, meta }
const videoTasks = new Map();

/* ----------------------------- 工具函数 ----------------------------- */
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}
function json(res, code, data) {
  cors(res);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
function readBody(req, limit = 100 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("请求体过大")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function comfyFetch(api, options = {}) {
  const url = COMFY + api;
  const r = await fetch(url, { ...options, signal: AbortSignal.timeout(600000) });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`ComfyUI ${api} 返回 ${r.status}: ${t.slice(0, 400)}`);
  }
  return r;
}
function loadWorkflow(file) {
  const wf = JSON.parse(fs.readFileSync(file, "utf8"));
  // 注入 SageAttention 加速节点（本机已装 sageattention 2.2 + sm120）
  // 在 QwenImage21Cache 与 CFGGuider 之间插入 PathchSageAttentionKJ
  if (process.env.DISABLE_SAGE !== "1") {
    try {
      const cacheId = findNode(wf, "QwenImage21Cache");
      const guiderId = findNode(wf, "CFGGuider");
      if (cacheId && guiderId && !findNode(wf, "PathchSageAttentionKJ")) {
        const sageId = "9001";
        wf[sageId] = {
          class_type: "PathchSageAttentionKJ",
          inputs: { model: [cacheId, 0], sage_attention: "auto", allow_compile: false },
        };
        wf[guiderId].inputs.model = [sageId, 0];
      }
    } catch (e) {
      console.log("  SageAttention 注入跳过:", e.message);
    }
  }
  return wf;
}
function findNode(wf, classType) {
  return Object.keys(wf).find((k) => wf[k].class_type === classType);
}
function parseSize(size) {
  const m = /^(\d+)\s*[x×*]\s*(\d+)$/.exec(String(size || ""));
  if (!m) return { width: 1024, height: 1024 };
  return { width: Math.max(64, +m[1]), height: Math.max(64, +m[2]) };
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 把参考图上传到 ComfyUI，返回可用于 LoadImage 的文件名 */
async function uploadReference(base64Data, filename = "reference.png") {
  const buf = Buffer.from(base64Data, "base64");
  const boundary = "----GatewayBoundary" + Date.now();
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\ninput\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, buf, tail]);
  const r = await fetch(`${COMFY}/upload/image`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error("上传参考图失败: " + (await r.text().catch(() => "")).slice(0, 300));
  const info = await r.json();
  console.log("  参考图已上传:", info.name || filename);
  return info.name || filename;
}

/** 提交工作流到 ComfyUI，轮询取图，返回 base64 数组 */
async function runWorkflow(wf) {
  const body = JSON.stringify({ prompt: wf, client_id: "local-canvas-gateway" });
  const pr = await comfyFetch("/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const result = await pr.json();
  if (result.error) throw new Error("ComfyUI 拒绝任务: " + JSON.stringify(result.error).slice(0, 500));
  const promptId = result.prompt_id;
  if (!promptId) throw new Error("ComfyUI 未返回 prompt_id: " + JSON.stringify(result).slice(0, 500));
  console.log(`  [${promptId}] 任务已提交`);

  // 轮询 history，等结果
  const deadline = Date.now() + 600000;
  let outputs = null;
  while (Date.now() < deadline) {
    await sleep(500);
    const hr = await fetch(`${COMFY}/history/${promptId}`, { signal: AbortSignal.timeout(15000) });
    if (!hr.ok) continue;
    const hist = await hr.json();
    const entry = hist[promptId];
    if (!entry) continue;
    if (entry.status?.status_str === "error" || entry.status?.completed === false && entry.status?.messages?.some((m) => m[0] === "execution_error")) {
      const msg = JSON.stringify(entry.status?.messages || entry.status || {}).slice(0, 600);
      throw new Error("ComfyUI 执行出错: " + msg);
    }
    if (entry.outputs) {
      outputs = entry.outputs;
      break;
    }
  }
  if (!outputs) throw new Error("等待 ComfyUI 结果超时（10 分钟）");

  // 收集所有 SaveImage 输出的图片
  const images = [];
  for (const nodeOut of Object.values(outputs)) {
    for (const img of nodeOut.images || []) {
      const q = new URLSearchParams({
        filename: img.filename,
        subfolder: img.subfolder || "",
        type: img.type || "output",
      });
      const vr = await comfyFetch("/view?" + q.toString());
      const buf = Buffer.from(await vr.arrayBuffer());
      images.push(buf.toString("base64"));
    }
  }
  if (!images.length) throw new Error("ComfyUI 未产出图片");
  console.log(`  [${promptId}] 完成，${images.length} 张图`);
  return images;
}

/* ----------------------------- 请求处理 ----------------------------- */
async function handleGeneration(req, res, isEdit) {
  try {
    const raw = await readBody(req);
    let body = {};
    let referenceImage = null;

    if (isEdit && req.headers["content-type"]?.includes("multipart/form-data")) {
      // 图生图： multipart（画布 /v1/images/edits 标准格式）
      const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(req.headers["content-type"]);
      if (!boundary) return json(res, 400, { error: { message: "缺少 multipart boundary" } });
      const b = boundary[1] || boundary[2];
      const parts = parseMultipart(raw, b);
      body = parts.fields || {};
      const imageField = parts.files?.image?.[0] || parts.files?.images?.[0];
      if (imageField) referenceImage = imageField.data.toString("base64");
    } else {
      body = JSON.parse(raw.toString("utf8") || "{}");
    }

    const prompt = String(body.prompt || "");
    if (!prompt.trim()) return json(res, 400, { error: { message: "缺少 prompt" } });
    const n = Math.max(1, Math.min(8, Number(body.n) || 1));
    const { width, height } = parseSize(body.size);
    console.log(`${isEdit ? "图生图" : "文生图"} prompt="${prompt.slice(0, 60)}" size=${width}x${height} n=${n}`);

    // 图生图：先把参考图上传到 ComfyUI，供 LoadImage 节点使用
    let refName = null;
    if (isEdit && referenceImage) {
      refName = await uploadReference(referenceImage, `ref_${Date.now()}.png`);
    }

    const allImages = [];
    for (let i = 0; i < n; i++) {
      const wf = loadWorkflow(isEdit ? EDIT_WORKFLOW : T2I_WORKFLOW);
      const encId = findNode(wf, "TextEncodeQwenImage21");
      const latentId = findNode(wf, "EmptyLatentImage");
      const noiseId = findNode(wf, "RandomNoise");
      wf[encId].inputs.prompt = prompt;
      wf[encId].inputs.resolution = isEdit ? 0 : Math.max(width, height);
      if (latentId) {
        wf[latentId].inputs.width = width;
        wf[latentId].inputs.height = height;
      }
      if (noiseId) wf[noiseId].inputs.noise_seed = Math.floor(Math.random() * 4294967295);
      // 图生图：插入 LoadImage 节点，把参考图接到 Qwen 编码器的 images 输入
      if (isEdit && refName) {
        const loadId = "9100";
        wf[loadId] = { class_type: "LoadImage", inputs: { image: refName } };
        wf[encId].inputs.images = { image_1: [loadId, 0] };
        // latent 来自编码器第 3 个输出（已含参考图），EmptyLatentImage 不再需要
        if (latentId) delete wf[latentId];
      }
      // 图生图：无一致性 LoRA 时移除 LoRA 节点（把 UNET 直连下游）
      if (isEdit) removeLoraIfMissing(wf);
      const imgs = await runWorkflow(wf);
      allImages.push(...imgs);
    }

    const fmt = body.response_format || "b64_json";
    if (fmt === "url") {
      // URL 模式：画布一般不用，这里也回 base64 data url
      json(res, 200, { created: Math.floor(Date.now() / 1000), data: allImages.map((b) => ({ url: `data:image/png;base64,${b}` })) });
    } else {
      json(res, 200, { created: Math.floor(Date.now() / 1000), data: allImages.map((b) => ({ b64_json: b })) });
    }
  } catch (e) {
    console.error("错误:", e.message);
    json(res, 500, { error: { message: e.message, type: "server_error" } });
  }
}

/* ----------------------------- 视频：MiniMax H3 ----------------------------- */

/** 从画布尺寸/参数推导 H3 的宽高帧数。8GB 显存默认 864x480 / 60帧(2.5秒)。宽高需 32 的倍数，帧数需 17n+5 */
function h3Geometry(size, seconds) {
  const { width, height } = parseSize(size);
  // 8GB 安全上限：短边不超过 480，长边不超过 864
  let w = Math.min(width || 864, 864);
  let h = Math.min(height || 480, 480);
  w = Math.max(32, Math.round(w / 32) * 32);
  h = Math.max(32, Math.round(h / 32) * 32);
  // 帧数取整到 17n+5（H3 网格），24fps
  let frames = Math.round((Number(seconds) || 3) * 24);
  frames = Math.max(22, Math.min(124, frames));
  frames = 5 + Math.round((frames - 5) / 17) * 17;
  return { width: w, height: h, length: frames };
}

/** 提交 H3 工作流到 ComfyUI，轮询完成后把生成的视频从 /view 取回本地，返回本地文件路径 */
async function runVideoWorkflow(wf, taskId) {
  const body = JSON.stringify({ prompt: wf, client_id: `h3-${taskId}` });
  const pr = await comfyFetch("/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const result = await pr.json();
  if (result.error) throw new Error("ComfyUI 拒绝任务: " + JSON.stringify(result.error).slice(0, 500));
  const promptId = result.prompt_id;
  if (!promptId) throw new Error("ComfyUI 未返回 prompt_id");
  console.log(`  [视频 ${taskId}] ComfyUI prompt=${promptId} 已提交`);

  // 轮询 history，视频生成较慢，放宽到 20 分钟
  const deadline = Date.now() + 20 * 60000;
  let outputs = null;
  while (Date.now() < deadline) {
    await sleep(1000);
    const hr = await fetch(`${COMFY}/history/${promptId}`, { signal: AbortSignal.timeout(15000) });
    if (!hr.ok) continue;
    const hist = await hr.json();
    const entry = hist[promptId];
    if (!entry) continue;
    const st = entry.status || {};
    if (st.status_str === "error" || st.messages?.some((m) => m[0] === "execution_error")) {
      const msg = JSON.stringify(st.messages || st).slice(0, 800);
      throw new Error("ComfyUI 视频执行出错: " + msg);
    }
    if (entry.outputs) { outputs = entry.outputs; break; }
  }
  if (!outputs) throw new Error("等待视频结果超时（20 分钟）");

  // 找 SaveVideo / VHS_VideoCombine 的输出（gifs 或 videos 字段）
  for (const nodeOut of Object.values(outputs)) {
    const media = nodeOut.gifs || nodeOut.videos || nodeOut.images || [];
    for (const item of media) {
      if (!item.filename) continue;
      const ext = path.extname(item.filename) || ".mp4";
      const q = new URLSearchParams({
        filename: item.filename,
        subfolder: item.subfolder || "",
        type: item.type || "output",
      });
      const vr = await comfyFetch("/view?" + q.toString());
      const buf = Buffer.from(await vr.arrayBuffer());
      const outFile = path.join(VIDEO_OUT_DIR, `${taskId}${ext}`);
      fs.writeFileSync(outFile, buf);
      console.log(`  [视频 ${taskId}] 完成: ${outFile} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
      return outFile;
    }
  }
  throw new Error("ComfyUI 未产出视频文件");
}

/** 异步执行视频任务，更新任务表状态 */
async function processVideoTask(taskId, wf) {
  try {
    videoTasks.get(taskId).status = "in_progress";
    const file = await runVideoWorkflow(wf, taskId);
    const task = videoTasks.get(taskId);
    task.status = "completed";
    task.file = file;
  } catch (e) {
    console.error(`  [视频 ${taskId}] 失败:`, e.message);
    const task = videoTasks.get(taskId);
    task.status = "failed";
    task.error = { message: e.message, type: "server_error" };
  }
}

/** POST /v1/videos —— 接收画布 multipart 提交，立即返回任务 id */
async function handleVideoSubmit(req, res) {
  try {
    const raw = await readBody(req, 100 * 1024 * 1024);
    let body = {};
    const ct = req.headers["content-type"] || "";
    if (ct.includes("multipart/form-data")) {
      const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
      if (!boundary) return json(res, 400, { error: { message: "缺少 multipart boundary" } });
      body = parseMultipart(raw, boundary[1] || boundary[2]).fields || {};
    } else {
      body = JSON.parse(raw.toString("utf8") || "{}");
    }
    const prompt = String(body.prompt || "");
    if (!prompt.trim()) return json(res, 400, { error: { message: "缺少 prompt" } });

    const model = String(body.model || VIDEO_MODEL_ID);
    const seconds = body.seconds || body.duration || 3;
    const size = body.size || body.resolution || "864x480";
    const { width, height, length } = h3Geometry(size, seconds);
    console.log(`文生视频 model=${model} prompt="${prompt.slice(0, 60)}" ${width}x${height} ${length}帧`);

    // 载入 H3 工作流，动态填充参数
    const wf = JSON.parse(fs.readFileSync(VIDEO_WORKFLOW, "utf8"));
    const condId = findNode(wf, "MiniMaxH3AudioConditioningT8");
    const noiseId = findNode(wf, "RandomNoise");
    wf[condId].inputs.prompt = prompt;
    wf[condId].inputs.width = width;
    wf[condId].inputs.height = height;
    wf[condId].inputs.length = length;
    // 有首帧/尾帧参考图时切到 FL2VA 模式（暂不实现上传，先支持纯文生视频）
    if (noiseId) wf[noiseId].inputs.noise_seed = Math.floor(Math.random() * 4294967295);

    const taskId = "vid_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
    videoTasks.set(taskId, {
      status: "queued",
      created: Math.floor(Date.now() / 1000),
      file: null,
      error: null,
      meta: { prompt: prompt.slice(0, 120), width, height, length, model },
    });
    // 后台跑，不阻塞提交响应
    processVideoTask(taskId, wf);
    return json(res, 200, { id: taskId, status: "queued", created: Math.floor(Date.now() / 1000) });
  } catch (e) {
    console.error("视频提交错误:", e.message);
    return json(res, 500, { error: { message: e.message, type: "server_error" } });
  }
}

/** GET /v1/videos/{id} —— 轮询任务状态 */
function handleVideoStatus(res, taskId) {
  const task = videoTasks.get(taskId);
  if (!task) return json(res, 404, { error: { message: "任务不存在", code: "task_not_found" } });
  const out = {
    id: taskId,
    status: task.status,
    created: task.created,
    model: task.meta?.model || VIDEO_MODEL_ID,
    progress: task.status === "completed" ? 100 : task.status === "in_progress" ? 50 : 0,
  };
  if (task.status === "completed") {
    out.video_url = `/v1/videos/${taskId}/content`;
    out.url = out.video_url;
  }
  if (task.status === "failed") out.error = task.error;
  return json(res, 200, out);
}

/** GET /v1/videos/{id}/content —— 返回 MP4 文件 */
function handleVideoContent(req, res, taskId) {
  const task = videoTasks.get(taskId);
  if (!task || task.status !== "completed" || !task.file || !fs.existsSync(task.file)) {
    return json(res, 404, { error: { message: "视频尚未生成或不存在" } });
  }
  cors(res);
  const stat = fs.statSync(task.file);
  res.writeHead(200, {
    "Content-Type": "video/mp4",
    "Content-Length": stat.size,
    "Content-Disposition": `inline; filename="${taskId}.mp4"`,
    "Accept-Ranges": "bytes",
  });
  fs.createReadStream(task.file).pipe(res);
}

/** 若工作流引用的 LoRA 文件不存在，则移除 LoraLoaderModelOnly 节点，让 model 直连下游 */
function removeLoraIfMissing(wf) {
  const loraId = findNode(wf, "LoraLoaderModelOnly");
  if (!loraId) return;
  const loraNode = wf[loraId];
  const loraName = loraNode.inputs?.lora_name || "";
  // 检查 ComfyUI 的 loras 目录（含子目录）
  const lorasDir = process.env.LORAS_DIR || "D:/ComfyUI-Easy/ComfyUI_windows_portable/ComfyUI/models/loras";
  const exists = findFileRecursive(lorasDir, path.basename(loraName));
  if (exists) return; // 有 LoRA，保留
  console.log(`  一致性 LoRA 缺失 (${path.basename(loraName)})，跳过该节点`);
  const modelInput = loraNode.inputs.model; // 如 ["460", 0]
  // 找谁把输出连到了这个 LoRA 节点，把那里改成直连下游
  for (const [k, v] of Object.entries(wf)) {
    for (const [key, val] of Object.entries(v.inputs || {})) {
      if (Array.isArray(val) && val[0] === loraId) {
        v.inputs[key] = modelInput;
      }
    }
  }
  delete wf[loraId];
}
function findFileRecursive(dir, name) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && e.name === name) return path.join(dir, e.name);
      if (e.isDirectory()) {
        const r = findFileRecursive(path.join(dir, e.name), name);
        if (r) return r;
      }
    }
  } catch {}
  return null;
}

/** 极简 multipart 解析：拆出字段和文件 */
function parseMultipart(buf, boundary) {
  const fields = {};
  const files = {};
  const sep = Buffer.from("--" + boundary);
  let pos = 0;
  while (true) {
    const start = buf.indexOf(sep, pos);
    if (start === -1) break;
    let p = start + sep.length;
    if (buf[p] === 0x2d && buf[p + 1] === 0x2d) break; // --
    if (buf[p] === 0x0d) p += 2; // \r\n
    const headerEnd = buf.indexOf("\r\n\r\n", p);
    if (headerEnd === -1) break;
    const header = buf.slice(p, headerEnd).toString("utf8");
    const dataStart = headerEnd + 4;
    const next = buf.indexOf(sep, dataStart);
    const dataEnd = next === -1 ? buf.length : next - 2; // 去掉 \r\n
    const data = buf.slice(dataStart, dataEnd);
    const nameM = /name="([^"]+)"/.exec(header);
    const fileM = /filename="([^"]*)"/.exec(header);
    if (nameM) {
      if (fileM) {
        (files[nameM[1]] ||= []).push({ filename: fileM[1], data });
      } else {
        fields[nameM[1]] = data.toString("utf8");
      }
    }
    pos = next === -1 ? buf.length : next;
  }
  return { fields, files };
}

/* ----------------------------- 系统资源监控 ----------------------------- */
/** GET /system/stats —— 转发 ComfyUI 系统状态，给画布顶栏显示内存/显存占用 */
async function handleSystemStats(res) {
  try {
    const r = await comfyFetch("/system_stats");
    const raw = await r.json();
    const sys = raw.system || {};
    const dev = (raw.devices || [])[0] || {};
    const ramTotal = sys.ram_total || 0;
    const ramFree = sys.ram_free || 0;
    const vramTotal = dev.vram_total || 0;
    const vramFree = dev.vram_free || 0;
    return json(res, 200, {
      ram: { total: ramTotal, free: ramFree, used: Math.max(0, ramTotal - ramFree) },
      vram: { total: vramTotal, free: vramFree, used: Math.max(0, vramTotal - vramFree) },
      device: dev.name || "GPU",
      queue: videoTasks.size,
    });
  } catch (e) {
    return json(res, 502, { error: { message: "无法读取 ComfyUI 状态: " + e.message } });
  }
}

/** POST /system/free —— 卸载模型 + 释放显存（ComfyUI /free） */
async function handleSystemFree(res) {
  try {
    const r = await comfyFetch("/free", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    });
    await r.text().catch(() => "");
    // 顺带清空当前队列（若卡住的任务）
    await fetch(COMFY + "/clear_queue", { method: "POST", signal: AbortSignal.timeout(10000) }).catch(() => {});
    console.log("[系统] 已清理显存/卸载模型");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return await handleSystemStats(res);
  } catch (e) {
    return json(res, 500, { error: { message: "清理失败: " + e.message } });
  }
}

/* ----------------------------- 版本信息（画布版本更新弹窗） ----------------------------- */
function textFile(res, file) {
  cors(res);
  try {
    const body = fs.readFileSync(file, "utf8");
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(body);
  } catch (e) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("");
  }
}

/* ----------------------------- 服务器 ----------------------------- */
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      return json(res, 200, {
        object: "list",
        data: [
          { id: MODEL_ID, object: "model", owned_by: "local-comfyui", display_name: "Qwen Image 2.1（本地）" },
          { id: VIDEO_MODEL_ID, object: "model", owned_by: "local-comfyui", display_name: "MiniMax H3 视频（本地）" },
        ],
      });
    }
    if (url.pathname === "/health" || url.pathname === "/") {
      return json(res, 200, { status: "ok", comfy: COMFY, model: MODEL_ID, videoModel: VIDEO_MODEL_ID, tasks: videoTasks.size });
    }
    // 系统资源监控（画布顶栏显示）
    if (req.method === "GET" && url.pathname === "/system/stats") {
      return await handleSystemStats(res);
    }
    if (req.method === "POST" && url.pathname === "/system/free") {
      return await handleSystemFree(res);
    }
    // 版本更新弹窗数据源（读本地文件）
    if (req.method === "GET" && url.pathname === "/version") {
      return textFile(res, VERSION_FILE);
    }
    if (req.method === "GET" && url.pathname === "/changelog") {
      return textFile(res, CHANGELOG_FILE);
    }
    if (req.method === "POST" && url.pathname === "/v1/images/generations") {
      return await handleGeneration(req, res, false);
    }
    if (req.method === "POST" && url.pathname === "/v1/images/edits") {
      return await handleGeneration(req, res, true);
    }
    // 视频：提交
    if (req.method === "POST" && url.pathname === "/v1/videos") {
      return await handleVideoSubmit(req, res);
    }
    // 视频：查状态 / 取内容
    let m;
    if (req.method === "GET" && (m = /^\/v1\/videos\/([^/]+)\/content$/.exec(url.pathname))) {
      return handleVideoContent(req, res, m[1]);
    }
    if (req.method === "GET" && (m = /^\/v1\/videos\/([^/]+)$/.exec(url.pathname))) {
      return handleVideoStatus(res, m[1]);
    }
    json(res, 404, { error: { message: "Not found", path: url.pathname } });
  } catch (e) {
    console.error("请求处理出错:", e);
    if (!res.headersSent) json(res, 500, { error: { message: e.message } });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`本地网关已启动: http://127.0.0.1:${PORT}`);
  console.log(`ComfyUI: ${COMFY}`);
  console.log(`画布里填 Base URL = http://127.0.0.1:${PORT}/v1`);
});
