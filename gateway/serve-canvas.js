/**
 * 极简静态服务器：托管画布 dist 到 3000 端口
 * 零依赖，Node 18+ 直接运行
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, "../web/dist");
const PORT = Number(process.env.CANVAS_PORT || 3000);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

http.createServer((req, res) => {
  let urlPath = decodeURIComponent(new URL(req.url, `http://x`).pathname);
  if (urlPath === "/") urlPath = "/index.html";
  let file = path.join(DIST, urlPath);
  // 防目录穿越
  if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
  // SPA 回退：找不到文件且无扩展名时返回 index.html
  if (!fs.existsSync(file) && !path.extname(file)) file = path.join(DIST, "index.html");
  if (!fs.existsSync(file)) { res.writeHead(404); res.end("Not found"); return; }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`画布已启动: http://127.0.0.1:${PORT}`);
});
