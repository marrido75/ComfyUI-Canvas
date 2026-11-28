/**
 * 极简本地网关：OpenAI 兼容接口 -> 本地 ComfyUI
 * 零第三方依赖，Node 18+ 直接运行
 *
 * 提供：
 *   GET  /v1/models                    模型列表（图片 + 视频）
 *   POST /v1/images/generations        文生图（Qwen Image 2.1 t2i）
 *   POST /v1/images/edits              图生图/参考图编辑（Qwen Image 2.1 edit）
 *   POST /v1/images/outpaint           扩图（Qwen Image 2.1 外补画板，左右上下扩展）
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
const INPAINT_WORKFLOW = path.join(__dirname, "qwen-inpaint.json");
const OUTPAINT_WORKFLOW = path.join(__dirname, "qwen-outpaint.json");
const VIDEO_WORKFLOW = path.join(__dirname, "h3-t2v.json");
const UPSCALE_WORKFLOW = path.join(__dirname, "relayvsr-x2-upscale-api.json");
// 额外的文生图模型：model id -> { 显示名, API 工作流, 注册表工作流 id }
// API 工作流是从 ComfyUI 官方 UI/subgraph 模板重构成的扁平 API 格式，网关可直接提交。
const EXTRA_IMAGE_MODELS = {
  "image-moss": {
    display: "MOSS-Image 文生图",
    displayEn: "MOSS-Image Text to Image",
    workflow: path.join(__dirname, "moss-image-t2i-api.json"),
    registryId: "moss-image",
  },
  "image-zimage": {
    display: "Z-Image Turbo 文生图",
    displayEn: "Z-Image Turbo Text to Image",
    workflow: path.join(__dirname, "z-image-t2i-api.json"),
    registryId: "z-image",
  },
  "image-krea2": {
    display: "Krea 2 文生图",
    displayEn: "Krea 2 Text to Image",
    workflow: path.join(__dirname, "krea2-t2i-api.json"),
    registryId: "krea2",
  },
  "image-moss-krea2": {
    display: "MOSS + Krea2 二采细化（优化版）",
    displayEn: "MOSS + Krea2 Two-Stage Refine",
    workflow: path.join(__dirname, "moss-krea2-refine-api.json"),
    registryId: "moss-krea2-refine",
  },
};
const VIDEO_OUT_DIR = path.join(__dirname, "video-outputs");
const PROJECT_ROOT = path.resolve(__dirname, "..");
const VERSION_FILE = path.join(PROJECT_ROOT, "VERSION");
const CHANGELOG_FILE = path.join(PROJECT_ROOT, "CHANGELOG.md");
const REGISTRY_FILE = path.join(__dirname, "workflow-registry.json");
// ComfyUI 根目录：优先环境变量，其次尝试项目旁的便携版默认位置
const COMFY_DIR = process.env.COMFY_DIR || path.resolve(PROJECT_ROOT, "..", "ComfyUI_windows_portable", "ComfyUI");
const MODELS_DIR = path.join(COMFY_DIR, "models");
const WORKFLOWS_USER_DIR = path.join(COMFY_DIR, "user", "default", "workflows");
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

/* ----------------------------- 实时进度追踪（ComfyUI WebSocket） ----------------------------- */
// ComfyUI 的 progress 消息只推送给「提交任务时用的同一个 clientId」的连接。
// runWorkflow 统一用 GATEWAY_CLIENT_ID 提交，这里用同一 clientId 建一条长连接收全部任务的进度。
const GATEWAY_CLIENT_ID = "local-canvas-gateway";
const progressTasks = new Map(); // prompt_id -> { step, total, percentage, status, startedAt, updatedAt }
let latestProgressId = null; // 最近提交的任务，供画布轮询（本地单用户场景）
let progressWs = null; // 当前进度 WebSocket（用于心跳检测）
let reconnectTimer = null; // 重连定时器（避免重复调度）

function scheduleProgressReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectProgressSocket();
  }, 2000);
}

function connectProgressSocket() {
  try {
    const wsUrl = COMFY.replace(/^http/, "ws") + `/ws?clientId=${GATEWAY_CLIENT_ID}`;
    const ws = new WebSocket(wsUrl);
    progressWs = ws;
    ws.onopen = () => {
      console.log("  [进度] WebSocket 已连接 ComfyUI");
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const d = msg.data;
      if (!d || !d.prompt_id) return;
      if (msg.type === "execution_start") {
        const t = progressTasks.get(d.prompt_id) || {};
        t.status = "running"; t.step = 0; t.total = 0; t.percentage = 0;
        t.startedAt = t.startedAt || Date.now(); t.updatedAt = Date.now();
        progressTasks.set(d.prompt_id, t);
      } else if (msg.type === "progress" || msg.type === "progress_state") {
        // 兼容两代 ComfyUI 进度消息：
        //   旧版 progress:       data.value / data.max
        //   新版 progress_state: data.nodes[nodeId].value / .max（可能多个节点，取正在跑的采样节点）
        let value = null, max = null;
        if (typeof d.value === "number" && typeof d.max === "number" && d.max > 0) {
          value = d.value; max = d.max;
        } else if (d.nodes && typeof d.nodes === "object") {
          let best = null;
          for (const node of Object.values(d.nodes)) {
            if (!node || typeof node.value !== "number" || typeof node.max !== "number" || node.max <= 0) continue;
            // 优先取仍在运行的节点，避免被已 finished 的辅助节点（如 VAE/文本编码 1/1）覆盖
            if (!best || (node.state !== "finished" && best.state === "finished")) best = node;
          }
          if (best) { value = best.value; max = best.max; }
        }
        if (value != null && max != null) {
          const t = progressTasks.get(d.prompt_id) || {};
          t.status = "running"; t.step = value; t.total = max;
          t.percentage = Math.max(0, Math.min(100, Math.round((value / max) * 100)));
          t.startedAt = t.startedAt || Date.now(); t.updatedAt = Date.now();
          progressTasks.set(d.prompt_id, t);
        }
      } else if ((msg.type === "executing" && d.node === null) || msg.type === "execution_success") {
        // 任务执行完毕（新版还会发 execution_success）
        const t = progressTasks.get(d.prompt_id);
        if (t) { t.status = "done"; t.percentage = 100; t.updatedAt = Date.now(); }
      }
    };
    // 断线/连接失败都要重连。关键：Connection refused 时 onerror 触发后 socket
    // 往往已经是 CLOSED，仅靠 close() 不会触发 onclose，必须在这里直接调度重连，
    // 否则「网关先于 ComfyUI 启动」时永远不再重连，进度一直停在 queued/step=0。
    ws.onclose = () => { if (progressWs === ws) progressWs = null; scheduleProgressReconnect(); };
    ws.onerror = () => { try { ws.close(); } catch {} scheduleProgressReconnect(); };
  } catch (e) {
    scheduleProgressReconnect();
  }
}
connectProgressSocket();

// 心跳兜底：每 5 秒检查一次，若连接不存在或非 OPEN 则重连（覆盖各种异常关闭路径）
setInterval(() => {
  if (!progressWs || progressWs.readyState !== 1 /* OPEN */) scheduleProgressReconnect();
}, 5000);

/** 供画布轮询：返回当前（最近提交的）生成任务进度 */
function handleProgress(res) {
  const id = latestProgressId;
  const t = id ? progressTasks.get(id) : null;
  if (!t) {
    return json(res, 200, { status: "idle", step: 0, total: 0, percentage: 0, elapsed: 0, promptId: null });
  }
  const elapsed = Math.round(((t.updatedAt || t.startedAt) - (t.startedAt || Date.now())) / 100) / 10;
  json(res, 200, {
    status: t.status || "running",
    step: t.step || 0,
    total: t.total || 0,
    percentage: t.percentage || 0,
    elapsed, // 秒
    promptId: id,
  });
}

/** 从 PNG/JPEG/WebP 的 base64 中读取像素尺寸（零依赖，解析文件头） */
function imageSizeFromBase64(base64) {
  try {
    const buf = Buffer.from(base64, "base64");
    // PNG: 宽高在字节 16/20（IHDR）
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // JPEG: 扫描 SOF0/SOF2 标记
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let p = 2;
      while (p < buf.length - 9) {
        if (buf[p] !== 0xff) { p++; continue; }
        const m = buf[p + 1];
        if (m === 0xc0 || m === 0xc1 || m === 0xc2 || m === 0xc3) {
          return { height: buf.readUInt16BE(p + 5), width: buf.readUInt16BE(p + 7) };
        }
        if (m === 0xd8 || m === 0xd9 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
        const len = buf.readUInt16BE(p + 2);
        p += 2 + len;
      }
    }
    // WebP VP8X / VP8 / VP8L
    if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
      const fmt = buf.toString("ascii", 12, 16);
      if (fmt === "VP8X") {
        return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      }
    }
  } catch {}
  return null;
}

/** 画布发来的遮罩提示词是长模板句，提取「修改要求：」之后的真实指令 */
function extractEditInstruction(prompt) {
  const s = String(prompt || "");
  const m = /修改要求[:：]\s*(.+)$/s.exec(s) || /Edit request[:：]\s*(.+)$/s.exec(s);
  return m && m[1].trim() ? m[1].trim() : s;
}

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

/** 把视频文件（Buffer）上传到 ComfyUI input 目录，返回可用于 LoadVideo 的文件名 */
async function uploadVideoFile(buf, filename = "upscale_input.mp4") {
  const boundary = "----GatewayBoundary" + Date.now();
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: video/mp4\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\ninput\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, buf, tail]);
  const r = await fetch(`${COMFY}/upload/image`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(180000),
  });
  if (!r.ok) throw new Error("上传视频失败: " + (await r.text().catch(() => "")).slice(0, 300));
  const info = await r.json();
  console.log("  视频已上传:", info.name || filename);
  return info.name || filename;
}

/** 提交工作流到 ComfyUI，轮询取图，返回 base64 数组 */
async function runWorkflow(wf) {
  const body = JSON.stringify({ prompt: wf, client_id: GATEWAY_CLIENT_ID });
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
  // 注册进度追踪
  progressTasks.set(promptId, { status: "queued", step: 0, total: 0, percentage: 0, startedAt: Date.now(), updatedAt: Date.now() });
  latestProgressId = promptId;

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
      const t = progressTasks.get(promptId); if (t) { t.status = "error"; t.updatedAt = Date.now(); }
      throw new Error("ComfyUI 执行出错: " + msg);
    }
    if (entry.outputs) {
      outputs = entry.outputs;
      break;
    }
  }
  if (!outputs) {
    const t = progressTasks.get(promptId); if (t) { t.status = "error"; t.updatedAt = Date.now(); }
    throw new Error("等待 ComfyUI 结果超时（10 分钟）");
  }

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
  if (!images.length) {
    const t = progressTasks.get(promptId); if (t) { t.status = "error"; t.updatedAt = Date.now(); }
    throw new Error("ComfyUI 未产出图片");
  }
  const doneTask = progressTasks.get(promptId); if (doneTask) { doneTask.status = "done"; doneTask.percentage = 100; doneTask.updatedAt = Date.now(); }
  console.log(`  [${promptId}] 完成，${images.length} 张图`);
  return images;
}

/* ----------------------------- 请求处理 ----------------------------- */
async function handleGeneration(req, res, isEdit) {
  try {
    const raw = await readBody(req);
    let body = {};
    const referenceImages = []; // 支持多张：image[] = [原图, mask, ...]

    if (isEdit && req.headers["content-type"]?.includes("multipart/form-data")) {
      // 图生图： multipart（画布 /v1/images/edits 标准格式）
      const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(req.headers["content-type"]);
      if (!boundary) return json(res, 400, { error: { message: "缺少 multipart boundary" } });
      const b = boundary[1] || boundary[2];
      const parts = parseMultipart(raw, b);
      body = parts.fields || {};
      // 画布发字段名 image[]（多图）或 image / images（单图），全部兼容
      const fileGroups = [parts.files?.["image[]"], parts.files?.image, parts.files?.images].filter(Boolean);
      for (const group of fileGroups) for (const f of group) referenceImages.push(f.data.toString("base64"));
    } else {
      body = JSON.parse(raw.toString("utf8") || "{}");
    }

    const prompt = String(body.prompt || "");
    if (!prompt.trim()) return json(res, 400, { error: { message: "缺少 prompt" } });
    const n = Math.max(1, Math.min(8, Number(body.n) || 1));
    const { width, height } = parseSize(body.size);
    // 文生图模型路由：body.model 可指定额外模型（MOSS / Z-Image / Krea2），默认 Qwen
    const requestedModel = String(body.model || MODEL_ID);
    const extraModel = !isEdit && EXTRA_IMAGE_MODELS[requestedModel] ? EXTRA_IMAGE_MODELS[requestedModel] : null;
    console.log(`${isEdit ? "图生图" : "文生图"} model=${requestedModel} prompt="${prompt.slice(0, 60)}" size=${width}x${height} n=${n}`);
    // 额外模型：先做就绪校验，未装好模型时给出清晰提示（而不是让 ComfyUI 报晦涩的 file not found）
    if (extraModel) {
      const registry = readRegistry();
      const wfCfg = (registry.workflows || []).find((w) => w.id === extraModel.registryId) || {};
      const missing = (wfCfg.models || []).filter((m) => !isModelInstalled(m.file, m.sizeBytes).installed).map((m) => m.file);
      if (!fs.existsSync(extraModel.workflow)) missing.push(`工作流 ${path.basename(extraModel.workflow)}`);
      if (missing.length) {
        return json(res, 400, { error: { message: `${extraModel.display} 尚未安装完成，缺少：${missing.join("、")}。请到「工作流」面板下载安装。` } });
      }
    }

    // 判断是否为「遮罩局部重绘」：画布发 2 张图（原图 + 蓝色标注叠加图）且提示词含修改要求模板
    const isMaskEdit = isEdit && referenceImages.length >= 2 &&
      /修改要求[:：]|Edit request[:：]/i.test(prompt);
    console.log(`  模式=${isMaskEdit ? "遮罩局部重绘(inpaint)" : isEdit ? "普通图生图" : "文生图"}`);
    if (isMaskEdit) console.log(`  修改指令="${extractEditInstruction(prompt)}"`);

    // 把所有参考图上传到 ComfyUI（第 1 张原图，第 2 张遮罩叠加图）
    const refNames = [];
    if (isEdit) {
      for (let k = 0; k < referenceImages.length; k++) {
        refNames.push(await uploadReference(referenceImages[k], `ref_${Date.now()}_${k}.png`));
      }
      console.log(`  已接收 ${referenceImages.length} 张参考图${referenceImages.length > 1 ? "（原图 + 遮罩）" : ""}`);
    }

    // 遮罩局部重绘时，用原图真实尺寸作为 latent 尺寸（保证遮罩与画面像素对齐）
    let mw = width, mh = height;
    if (isMaskEdit) {
      const sz = imageSizeFromBase64(referenceImages[0]);
      if (sz) {
        mw = Math.max(64, Math.round(sz.width / 32) * 32);
        mh = Math.max(64, Math.round(sz.height / 32) * 32);
        console.log(`  原图尺寸 ${sz.width}x${sz.height} -> latent ${mw}x${mh}`);
      }
    }

    const allImages = [];
    for (let i = 0; i < n; i++) {
      /* ---------- 额外文生图模型（MOSS / Z-Image / Krea2）：扁平 API 工作流 ---------- */
      if (extraModel) {
        const wf = loadWorkflow(extraModel.workflow);
        // 这些工作流统一用 id "4" 的 CLIPTextEncode 注入正向提示词
        if (wf["4"] && wf["4"].class_type === "CLIPTextEncode") wf["4"].inputs.text = prompt;
        // 二采工作流：阶段2 的正向提示词节点 "25" 复用同一提示词
        if (wf["25"] && wf["25"].class_type === "CLIPTextEncode") wf["25"].inputs.text = prompt;
        // latent 节点：EmptyFlux2LatentImage / EmptySD3LatentImage / EmptyLatentImage
        for (const key of ["6"]) {
          if (wf[key] && wf[key].inputs && "width" in wf[key].inputs) {
            wf[key].inputs.width = width;
            wf[key].inputs.height = height;
          }
        }
        // 随机种子：KSampler 的 seed（id "7"）
        if (wf["7"] && wf["7"].class_type === "KSampler") {
          wf["7"].inputs.seed = Math.floor(Math.random() * 4294967295);
        }
        const imgs = await runWorkflow(wf);
        allImages.push(...imgs);
        continue;
      }

      /* ---------- 遮罩局部重绘：真 inpaint 链路 ---------- */
      if (isMaskEdit) {
        const wf = loadWorkflow(INPAINT_WORKFLOW);
        const encId = findNode(wf, "TextEncodeQwenImage21GH");
        // 接线：原图 -> 9100，遮罩叠加图 -> 9101（差异节点自动提取遮罩）
        wf["9100"].inputs.image = refNames[0];
        wf["9101"].inputs.image = refNames[1];
        wf[encId].inputs.prompt = extractEditInstruction(prompt);
        wf[encId].inputs.latent_width = mw;
        wf[encId].inputs.latent_height = mh;
        const noiseId = findNode(wf, "RandomNoise");
        if (noiseId) wf[noiseId].inputs.noise_seed = Math.floor(Math.random() * 4294967295);
        // 一致性 LoRA 若缺失则自动移除（UNET 直连）
        removeLoraIfMissing(wf);
        const imgs = await runWorkflow(wf);
        allImages.push(...imgs);
        continue;
      }

      /* ---------- 普通图生图 / 文生图（原逻辑） ---------- */
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
      if (isEdit && refNames.length) {
        const imagesInput = {};
        refNames.forEach((name, idx) => {
          const loadId = String(9100 + idx);
          wf[loadId] = { class_type: "LoadImage", inputs: { image: name } };
          imagesInput[`image_${idx + 1}`] = [loadId, 0];
        });
        wf[encId].inputs.images = imagesInput;
        if (latentId) delete wf[latentId];
      }
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

/* ----------------------------- 扩图：Qwen Image 2.1 外补画板 ----------------------------- */

/**
 * POST /v1/images/outpaint — 扩图
 * 接受 multipart（字段 image / image[]）或 JSON（字段 image 为 base64/dataURL）
 * 参数：
 *   left/right/top/bottom  扩展像素（默认 256/256/0/0）
 *   unit                   "像素" | "百分比"（默认像素）
 *   prompt                 可选：对扩展区域的额外描述
 *   response_format        b64_json（默认）| url
 */
async function handleOutpaint(req, res) {
  try {
    const raw = await readBody(req);
    let body = {};
    let sourceBase64 = null;
    if (req.headers["content-type"]?.includes("multipart/form-data")) {
      const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(req.headers["content-type"]);
      if (!boundary) return json(res, 400, { error: { message: "缺少 multipart boundary" } });
      const parts = parseMultipart(raw, boundary[1] || boundary[2]);
      body = parts.fields || {};
      const files = parts.files?.["image[]"] || parts.files?.image || parts.files?.images || [];
      if (files.length) sourceBase64 = files[0].data.toString("base64");
    } else {
      body = JSON.parse(raw.toString("utf8") || "{}");
      if (body.image) {
        sourceBase64 = String(body.image).replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, "");
      }
    }
    if (!sourceBase64) return json(res, 400, { error: { message: "缺少输入图片（image）" } });

    const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
    const left = Math.max(0, Math.round(num(body.left, 256)));
    const right = Math.max(0, Math.round(num(body.right, 256)));
    const top = Math.max(0, Math.round(num(body.top, 0)));
    const bottom = Math.max(0, Math.round(num(body.bottom, 0)));
    const unit = body.unit === "百分比" || body.unit === "percent" ? "百分比" : "像素";
    const userPrompt = String(body.prompt || "").trim();
    const n = Math.max(1, Math.min(4, num(body.n, 1)));
    console.log(`扩图 扩展=${unit === "像素" ? `${left}/${right}/${top}/${bottom}px` : `${left}/${right}/${top}/${bottom}%`} n=${n} prompt="${userPrompt.slice(0, 40)}"`);

    const srcName = await uploadReference(sourceBase64, `outpaint_src_${Date.now()}.png`);

    const allImages = [];
    for (let i = 0; i < n; i++) {
      const wf = loadWorkflow(OUTPAINT_WORKFLOW);
      wf["9100"].inputs.image = srcName;
      wf["4800"].inputs["单位"] = unit;
      wf["4800"].inputs["左"] = left;
      wf["4800"].inputs["右"] = right;
      wf["4800"].inputs["上"] = top;
      wf["4800"].inputs["下"] = bottom;
      const encId = findNode(wf, "TextEncodeQwenImage21GH");
      if (encId) {
        wf[encId].inputs.prompt = userPrompt
          ? `移除图像中的灰色区域，无缝自然延展为完整图像。${userPrompt}`
          : "移除图像中的灰色区域，无缝自然延展为完整图像。";
      }
      const noiseId = findNode(wf, "RandomNoise");
      if (noiseId) wf[noiseId].inputs.noise_seed = Math.floor(Math.random() * 4294967295);
      removeLoraIfMissing(wf);
      const imgs = await runWorkflow(wf);
      allImages.push(...imgs);
    }

    const fmt = body.response_format || "b64_json";
    if (fmt === "url") {
      json(res, 200, { created: Math.floor(Date.now() / 1000), data: allImages.map((b) => ({ url: `data:image/png;base64,${b}` })) });
    } else {
      json(res, 200, { created: Math.floor(Date.now() / 1000), data: allImages.map((b) => ({ b64_json: b })) });
    }
  } catch (e) {
    console.error("扩图错误:", e.message);
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
  // 关键：只取 type=output 的结果。LoadVideo 等输入节点也会暴露 images，
  // 但 type=input，若误取会把原始输入视频当成结果（放大后分辨率不变就是这个问题）。
  for (const nodeOut of Object.values(outputs)) {
    const media = nodeOut.gifs || nodeOut.videos || nodeOut.images || [];
    for (const item of media) {
      if (!item.filename) continue;
      if (item.type && item.type !== "output") continue; // 跳过 input/temp 等非最终输出
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

/** POST /v1/videos/upscale —— RelayVSR 视频 2x 放大（接收画布上传的 MP4） */
async function handleVideoUpscale(req, res) {
  try {
    const registry = readRegistry();
    const wfCfg = (registry.workflows || []).find((w) => w.id === "relayvsr-x2-upscale") || {};
    const missing = (wfCfg.models || []).filter((m) => !isModelInstalled(m.file, m.sizeBytes).installed).map((m) => m.file);
    if (missing.length) {
      return json(res, 400, { error: { message: `RelayVSR 放大尚未安装完成，缺少：${missing.join("、")}。请到「工作流」面板下载安装。` } });
    }

    const raw = await readBody(req, 500 * 1024 * 1024);
    const ct = req.headers["content-type"] || "";
    const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
    if (!ct.includes("multipart/form-data") || !boundary) {
      return json(res, 400, { error: { message: "放大视频需要 multipart/form-data 上传文件" } });
    }
    const { files } = parseMultipart(raw, boundary[1] || boundary[2]);
    const fileKey = Object.keys(files)[0];
    if (!fileKey || !files[fileKey]?.length) return json(res, 400, { error: { message: "未收到视频文件" } });
    const vf = files[fileKey][0];
    const ext = path.extname(vf.filename) || ".mp4";
    const inputName = await uploadVideoFile(vf.data, `upscale_${Date.now()}${ext}`);

    const wf = JSON.parse(fs.readFileSync(UPSCALE_WORKFLOW, "utf8"));
    if (wf["1"] && wf["1"].inputs) wf["1"].inputs.file = inputName;

    const taskId = "up_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
    videoTasks.set(taskId, {
      status: "queued",
      created: Math.floor(Date.now() / 1000),
      file: null,
      error: null,
      meta: { model: "video-relayvsr-x2", source: vf.filename, kind: "upscale" },
    });
    processVideoTask(taskId, wf);
    return json(res, 200, { id: taskId, status: "queued", created: Math.floor(Date.now() / 1000) });
  } catch (e) {
    console.error("视频放大提交错误:", e.message);
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
  console.log(`  LoRA 缺失 (${path.basename(loraName)})，跳过该节点`);
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

/* ----------------------------- 工作流与模型管理（画布「工作流」Tab） ----------------------------- */
// 当前下载任务：file -> { status, downloaded, total, percentage, speed, error, startedAt }
const downloadTasks = new Map();
let latestDownloadFile = null;
const MS_BASE = "https://www.modelscope.cn/models";

function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
  } catch (e) {
    console.error("[工作流] 读取注册表失败:", e.message);
    return { workflows: [] };
  }
}

/** 检查单个模型文件是否已在本地（兼容子目录，如 Qwen-功能2.1\xxx）
 *  expectedSize>0 时会做完整性校验：文件存在但明显小于预期 → 判定为半成品(partial)，可被断点续传。 */
function isModelInstalled(relFile, expectedSize) {
  const inspect = (p, extra) => {
    const size = fs.statSync(p).size;
    if (size <= 1024) return null;
    // 只对提供了预期大小的可扩展工作流做完整性校验，避免误伤已有工作流
    if (expectedSize && size < expectedSize * 0.98) {
      return { installed: false, localSize: size, partial: true, ...extra };
    }
    return { installed: true, localSize: size, ...extra };
  };
  const direct = path.join(MODELS_DIR, relFile);
  try { if (fs.existsSync(direct)) { const r = inspect(direct, {}); if (r) return r; } } catch {}
  // 递归在模型根目录下按文件名查找（部分用户把模型放进子文件夹）
  const base = path.basename(relFile);
  try {
    const found = findFileByName(MODELS_DIR, base, 3);
    if (found) { const r = inspect(found, { localPath: found }); if (r) return r; }
  } catch {}
  return { installed: false, localSize: 0 };
}

function findFileByName(dir, name, depth) {
  if (depth < 0 || !fs.existsSync(dir)) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (e.isFile() && e.name === name) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const r = findFileByName(path.join(dir, e.name), name, depth - 1);
      if (r) return r;
    }
  }
  return null;
}

/** GET /v1/workflows —— 列出工作流，并标注每个模型的本地安装状态 */
function handleWorkflowsList(res) {
  const registry = readRegistry();
  const comfyDirValid = fs.existsSync(MODELS_DIR);
  const workflows = (registry.workflows || []).map((wf) => {
    const models = (wf.models || []).map((m) => ({ ...m, ...isModelInstalled(m.file, m.sizeBytes) }));
    const installedCount = models.filter((m) => m.installed).length;
    return {
      ...wf,
      models,
      installedCount,
      totalCount: models.length,
      allInstalled: installedCount === models.length && models.length > 0,
      workflowInstalled: wf.workflowFile ? fs.existsSync(path.join(__dirname, wf.workflowFile)) : wf.status === "existing",
    };
  });
  return json(res, 200, { workflows, comfyDir: COMFY_DIR, comfyDirValid });
}

/**
 * 列出全部「图片」模型（含就绪状态）。
 * 每个额外模型就绪条件：API 工作流文件存在 + 注册表模型全部安装。
 * 就绪的才会进入 /v1/models 下拉；未就绪的仍带 missing 信息，方便前端提示。
 */
function listImageModels() {
  const registry = readRegistry();
  const byId = {};
  for (const wf of registry.workflows || []) byId[wf.id] = wf;

  const models = [
    {
      id: MODEL_ID,
      display_name: "Qwen Image 2.1（本地）",
      ready: true,
      builtin: true,
    },
  ];
  for (const [id, cfg] of Object.entries(EXTRA_IMAGE_MODELS)) {
    const wf = byId[cfg.registryId] || {};
    const missing = [];
    for (const m of wf.models || []) {
      const st = isModelInstalled(m.file, m.sizeBytes);
      if (!st.installed) missing.push(m.file);
    }
    const apiWorkflowExists = fs.existsSync(cfg.workflow);
    const ready = missing.length === 0 && apiWorkflowExists;
    models.push({
      id,
      display_name: cfg.display,
      display_name_en: cfg.displayEn,
      ready,
      missing,
      workflowExists: apiWorkflowExists,
    });
  }
  return models;
}

/** GET /v1/models/download/progress —— 返回全部下载任务的进度（支持并发）
 *  响应: { tasks: { [file]: {status,file,downloaded,total,percentage,speed,error} }, latest: <file|null> } */
function handleDownloadProgress(res) {
  const tasks = {};
  for (const [file, t] of downloadTasks) tasks[file] = t;
  return json(res, 200, { tasks, latest: latestDownloadFile });
}

/** 下载单个模型（流式写入 + 断点续传 + 进度回调） */
async function downloadModel(job) {
  const { file, repo, remotePath } = job;
  const dest = path.join(MODELS_DIR, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  // 已完整下载则直接完成
  let existing = 0;
  try { if (fs.existsSync(dest)) existing = fs.statSync(dest).size; } catch {}
  let total = job.sizeBytes || 0;
  try {
    const probe = await fetch(`${MS_BASE}/${repo}/resolve/master/${remotePath}`, { method: "HEAD", signal: AbortSignal.timeout(30000) });
    if (probe.ok) total = Number(probe.headers.get("content-length") || 0) || total;
  } catch { /* HEAD 失败则用注册表 sizeBytes 兜底，不阻断下载 */ }
  if (existing > 0 && total > 0 && existing >= total) {
    downloadTasks.set(file, { status: "done", file, downloaded: existing, total, percentage: 100, speed: 0, error: null });
    return;
  }

  const headers = {};
  if (existing > 0 && total > 0 && existing < total) headers.Range = `bytes=${existing}-`;
  const response = await fetch(`${MS_BASE}/${repo}/resolve/master/${remotePath}`, { headers, signal: AbortSignal.timeout(600000) });
  if (!response.ok && response.status !== 206) throw new Error(`ModelScope 返回 ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") || 0);
  const finalTotal = existing + contentLength || total;
  downloadTasks.set(file, { status: "downloading", file, downloaded: existing, total: finalTotal, percentage: finalTotal ? Math.round((existing / finalTotal) * 100) : 0, speed: 0, error: null, startedAt: Date.now() });

  const flag = { value: false };
  downloadAborts.set(file, flag);
  const writer = fs.createWriteStream(dest, { flags: existing > 0 ? "a" : "w" });
  // 关键：writer 自身可能异步触发 error（尤其 destroy 后仍有 pending 写入），
  // 必须挂监听器，否则未捕获的 error 事件会让整个网关进程崩溃。
  writer.on("error", () => {});
  const reader = response.body.getReader();
  let downloaded = existing;
  let lastBytes = existing;
  let lastTime = Date.now();

  try {
    for (;;) {
      if (flag.value) { try { await reader.cancel(); } catch {} throw new Error("__CANCELLED__"); }
      const { done, value } = await reader.read();
      if (done) break;
      if (flag.value || writer.destroyed) { try { await reader.cancel(); } catch {} throw new Error("__CANCELLED__"); }
      writer.write(Buffer.from(value));
      downloaded += value.length;
      const now = Date.now();
      const speed = now - lastTime >= 500 ? Math.round(((downloaded - lastBytes) / 1024 / 1024) / ((now - lastTime) / 1000) * 10) / 10 : undefined;
      if (speed !== undefined) { lastBytes = downloaded; lastTime = now; }
      downloadTasks.set(file, {
        status: "downloading", file, downloaded, total: finalTotal,
        percentage: finalTotal ? Math.min(100, Math.round((downloaded / finalTotal) * 100)) : 0,
        speed: speed ?? (downloadTasks.get(file)?.speed || 0),
        error: null, startedAt: downloadTasks.get(file)?.startedAt || Date.now(),
      });
    }
    await new Promise((resolve) => {
      if (writer.destroyed) return resolve();
      writer.end(resolve);
      setTimeout(resolve, 5000); // 兜底，避免 end 回调丢失导致挂起
    });
    downloadTasks.set(file, { status: "done", file, downloaded, total: finalTotal, percentage: 100, speed: 0, error: null });
    console.log(`[下载] 完成: ${file}`);
  } catch (e) {
    writer.destroy();
    if (e.message === "__CANCELLED__") {
      downloadTasks.set(file, { status: "canceled", file, downloaded, total: finalTotal, percentage: finalTotal ? Math.round((downloaded / finalTotal) * 100) : 0, speed: 0, error: "已取消" });
    } else {
      downloadTasks.set(file, { status: "error", file, downloaded, total: finalTotal, percentage: 0, speed: 0, error: e.message });
    }
    throw e;
  } finally {
    downloadAborts.delete(file);
  }
}
const downloadAborts = new Map();

/** POST /v1/models/download —— 启动下载（异步），立即返回 */
async function handleModelDownload(req, res) {
  const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
  const { file, repo, remotePath, sizeBytes } = body;
  if (!file || !repo || !remotePath) return json(res, 400, { error: { message: "缺少 file/repo/remotePath" } });
  // 防目录穿越：目标必须落在 MODELS_DIR 内
  const dest = path.resolve(MODELS_DIR, file);
  if (!dest.startsWith(path.resolve(MODELS_DIR))) return json(res, 400, { error: { message: "非法路径" } });

  // 防重复：同一文件已在排队/下载中则不再启动，避免写坏同一文件
  const prev = downloadTasks.get(file);
  if (prev && (prev.status === "queued" || prev.status === "downloading")) {
    return json(res, 200, { ok: false, file, reason: "already-running", message: "该文件正在下载中" });
  }

  latestDownloadFile = file;
  downloadTasks.set(file, { status: "queued", file, downloaded: 0, total: sizeBytes || 0, percentage: 0, speed: 0, error: null, startedAt: Date.now() });
  downloadModel({ file, repo, remotePath, sizeBytes }).catch((e) => {
    if (e.message !== "__CANCELLED__") console.error("[下载] 失败:", file, e.message);
  });
  return json(res, 200, { ok: true, file });
}

/** POST /v1/models/download/cancel —— 取消指定文件下载；未指定 file 则取消全部 */
async function handleDownloadCancel(req, res) {
  let parsed = {};
  try { parsed = JSON.parse((await readBody(req)).toString("utf8") || "{}"); } catch {}
  const file = parsed.file;
  if (file) {
    const flag = downloadAborts.get(file);
    if (flag) flag.value = true;
    const t = downloadTasks.get(file);
    if (t && (t.status === "queued" || t.status === "downloading")) {
      downloadTasks.set(file, { ...t, status: "canceled", error: "已取消", speed: 0 });
    }
    return json(res, 200, { ok: true, file });
  }
  // 未指定则取消全部
  let count = 0;
  for (const [, flag] of downloadAborts) { flag.value = true; count++; }
  for (const [f, t] of downloadTasks) {
    if (t.status === "queued" || t.status === "downloading") downloadTasks.set(f, { ...t, status: "canceled", error: "已取消", speed: 0 });
  }
  return json(res, 200, { ok: true, canceled: count });
}

/** POST /v1/workflows/install —— 下载官方工作流 JSON 到 ComfyUI 与网关目录 */
async function handleWorkflowInstall(req, res) {
  const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
  const { workflowUrl, workflowFile } = body;
  if (!workflowUrl || !workflowFile || !/^[\w.-]+\.json$/.test(workflowFile)) {
    return json(res, 400, { error: { message: "参数无效" } });
  }
  try {
    const r = await fetch(workflowUrl, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`下载工作流失败 ${r.status}`);
    const text = await r.text();
    JSON.parse(text); // 校验是合法 JSON
    // 保存到 ComfyUI 用户工作流目录（UI 可导入）与网关目录（备份）
    try { fs.mkdirSync(WORKFLOWS_USER_DIR, { recursive: true }); fs.writeFileSync(path.join(WORKFLOWS_USER_DIR, workflowFile), text); } catch {}
    fs.writeFileSync(path.join(__dirname, workflowFile), text);
    return json(res, 200, { ok: true, file: workflowFile });
  } catch (e) {
    return json(res, 500, { error: { message: e.message } });
  }
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
    // 当前生成任务实时进度（画布轮询显示进度条 / 计时）
    if (req.method === "GET" && url.pathname === "/v1/images/progress") {
      return handleProgress(res);
    }
    if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      const imageModels = listImageModels();
      const data = [];
      for (const m of imageModels) {
        data.push({ id: m.id, object: "model", owned_by: "local-comfyui", display_name: m.display_name, ready: m.ready, ...(m.missing?.length ? { missing: m.missing } : {}) });
      }
      data.push({ id: VIDEO_MODEL_ID, object: "model", owned_by: "local-comfyui", display_name: "MiniMax H3 视频（本地）", ready: true });
      return json(res, 200, { object: "list", data });
    }
    if (url.pathname === "/health" || url.pathname === "/") {
      const imageModels = listImageModels();
      return json(res, 200, {
        status: "ok",
        comfy: COMFY,
        model: MODEL_ID,
        videoModel: VIDEO_MODEL_ID,
        imageModels: imageModels.map((m) => ({ id: m.id, display_name: m.display_name, ready: m.ready })),
        tasks: videoTasks.size,
      });
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
    // 工作流与模型管理（画布「工作流」Tab）
    if (req.method === "GET" && url.pathname === "/v1/workflows") {
      return handleWorkflowsList(res);
    }
    if (req.method === "GET" && url.pathname === "/v1/models/download/progress") {
      return handleDownloadProgress(res);
    }
    if (req.method === "POST" && url.pathname === "/v1/models/download") {
      return await handleModelDownload(req, res);
    }
    if (req.method === "POST" && url.pathname === "/v1/models/download/cancel") {
      return await handleDownloadCancel(req, res);
    }
    if (req.method === "POST" && url.pathname === "/v1/workflows/install") {
      return await handleWorkflowInstall(req, res);
    }
    if (req.method === "POST" && url.pathname === "/v1/images/generations") {
      return await handleGeneration(req, res, false);
    }
    if (req.method === "POST" && url.pathname === "/v1/images/edits") {
      return await handleGeneration(req, res, true);
    }
    if (req.method === "POST" && url.pathname === "/v1/images/outpaint") {
      return await handleOutpaint(req, res);
    }
    // 视频：提交
    if (req.method === "POST" && url.pathname === "/v1/videos") {
      return await handleVideoSubmit(req, res);
    }
    // 视频放大：RelayVSR 2x（注意放在 /v1/videos/{id} 通配之前）
    if (req.method === "POST" && url.pathname === "/v1/videos/upscale") {
      return await handleVideoUpscale(req, res);
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
