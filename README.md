# 无限画布 · 本地 ComfyUI 定制版（v1.0.0）

> 本项目基于 [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas) v0.20.0（MIT，Copyright (c) 2026 basketikun）修改，保留其许可证与版权声明，详见 [LICENSE](LICENSE) 与 [CHANGELOG.md](CHANGELOG.md)。

这是一个把无限画布接入**本地 ComfyUI** 的定制分支：用一个零依赖的 Node 网关把画布的文生图、图生图、文生视频请求转发到本地 ComfyUI（Qwen Image 2.1 + MiniMax H3），数据完全跑在本机，不依赖任何云端 API Key。

## 本分支新增 / 改动

- **本地极简网关**（`gateway/server.js`）：OpenAI 兼容接口，转发到本机 ComfyUI（默认 `127.0.0.1:8188`）
  - `POST /v1/images/generations` 文生图（Qwen Image 2.1 turbo int8，SageAttention 加速，约 8 秒/张）
  - `POST /v1/images/edits` 图生图 / 参考图编辑（上传参考图走 `LoadImage`）
  - `POST /v1/videos` 文生视频（MiniMax H3，864×480 / 4 步，输出带同步音轨的 MP4，异步任务）
  - `GET /v1/models`、`GET /system/stats`、`POST /system/free`、`GET /version`、`GET /changelog`
- **顶栏资源监控**：实时显示显存 / 内存占用，一键卸载模型、释放显存
- **版本更新弹窗**：数据源指向本地网关，可改成本机或你自己的 GitHub 仓库
- **界面精简**：移除生图工作台、视频创作台、提示词库导航入口及首页提示词展示区
- **SageAttention 加速**：集成 sageattention 2.2，文生图从约 27 秒降到约 8 秒

## 快速开始（Windows 本地部署）

### 1. 依赖准备
- **ComfyUI 便携版**：放在 `D:\ComfyUI-Easy\ComfyUI_windows_portable`，已装好 Qwen Image 2.1 turbo int8 与 MiniMax H3 所需的节点和模型，监听 `8188`
- **Node 18+**：本项目原本随附便携版 Node（目录 `node/`，未随仓库上传），需自行准备，或用系统已安装的 Node

### 2. 安装前端依赖并构建
```bash
cd web
npm install --legacy-peer-deps
npm run build
```
> 前端构建产物 `web/dist/` 未随仓库上传（已加入 `.gitignore`），clone 后必须执行上面两步。

### 3. 一键启动
双击项目根目录的 `start-all.bat`，它会依次拉起：ComfyUI（8188）→ 网关（8190）→ 画布静态服务（3000）。

也可分别手动启动：
```bash
node gateway/server.js         # 网关 8190
node gateway/serve-canvas.js   # 画布 3000
```

### 4. 画布配置
打开 `http://127.0.0.1:3000`，右上角「配置 → 渠道」新增一个渠道：
- **Base URL**：`http://127.0.0.1:8190/v1`
- **API Key**：任意填写（本地网关不校验）
- 模型：`image-qwen21`（生图）、`video-minimax-h3`（视频）

详细配置、模型清单和常见问题见 **[本地网关说明.md](本地网关说明.md)**。

## 模型清单

### Qwen Image 2.1（文生图 / 图生图）

生图链路使用的模型，总计约 16.1G：

| 目录 | 文件 | 大小 |
|---|---|---|
| `models/diffusion_models/` | qwen_image_2.1_turbo_int8_convrot.safetensors | 6.8G |
| `models/text_encoders/` | qwen3vl_8b_int8_convrot.safetensors | 8.7G |
| `models/vae/` | qwen_image_2.1_vae_bf16.safetensors | 0.6G |

文生图走 `qwen-t2i.json`（注入 SageAttention 加速，约 8 秒/张）；图生图走 `qwen-edit.json`，参考图通过 `LoadImage` 节点注入。

### MiniMax H3（文生视频）

视频链路使用的模型，来自 ModelScope 的 `Comfy-Org/MiniMax-H3`，总计约 34.5G：

| 目录 | 文件 | 大小 |
|---|---|---|
| `models/diffusion_models/` | minimax_h3_fl2va_pruned_w6a8.safetensors | 14.9G |
| `models/text_encoders/` | qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors | 14.6G |
| `models/vae/` | minimax_h3_video_vae_int8_convrot.safetensors | 2.6G |
| `models/vae/` | minimax_h3_audio_vae_fp32.safetensors | 0.6G |
| `models/loras/` | minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors | 1.8G |
