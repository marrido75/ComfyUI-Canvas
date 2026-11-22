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

## 模型清单（MiniMax H3）

| 目录 | 文件 | 大小 |
|---|---|---|
| `models/diffusion_models/` | minimax_h3_fl2va_pruned_w6a8.safetensors | 14.9G |
| `models/text_encoders/` | qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors | 14.6G |
| `models/vae/` | minimax_h3_video_vae_int8_convrot.safetensors | 2.6G |
| `models/vae/` | minimax_h3_audio_vae_fp32.safetensors | 0.6G |
| `models/loras/` | minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors | 1.8G |

模型来自 ModelScope 的 `Comfy-Org/MiniMax-H3`，总计约 34.5G。

---

<p align="center">
  <img src="web/public/logo.svg" width="96" alt="infinite-canvas logo">
</p>

<h1 align="center">无限画布 (infinite-canvas) — 上游项目说明</h1>

<p align="center">
  <a href="https://linux.do/"><img src="https://img.shields.io/badge/Linux.do-Community-2b6de8?style=flat-square" alt="Linux.do"></a>
  <a href="https://render.com/deploy?repo=https://github.com/basketikun/infinite-canvas"><img src="https://img.shields.io/badge/Render-Deploy-46e3b7?style=flat-square&logo=render&logoColor=111111" alt="Deploy to Render"></a>
  <a href="https://github.com/basketikun/infinite-canvas"><img src="https://img.shields.io/github/stars/basketikun/infinite-canvas?style=flat-square&logo=github" alt="GitHub stars"></a>
  <a href="https://github.com/basketikun/infinite-canvas/tags"><img src="https://img.shields.io/github/v/tag/basketikun/infinite-canvas?style=flat-square&label=version" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-f97316?style=flat-square" alt="License"></a>
  <a href="https://vite.dev/"><img src="https://img.shields.io/badge/Vite-7-646cff?style=flat-square&logo=vite&logoColor=white" alt="Vite"></a>
  <a href="https://reactrouter.com/"><img src="https://img.shields.io/badge/React_Router-7-ca4245?style=flat-square&logo=reactrouter&logoColor=white" alt="React Router"></a>
</p>

<p align="center">
<a href="https://trendshift.io/repositories/50077?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-50077" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/50077" alt="basketikun%2Finfinite-canvas | Trendshift" width="250" height="55"/></a>
</p>

<p align="center">
  <a href="docs/content/docs/overview/quick-start.mdx">快速开始</a> · <a href="docs/content/docs/overview/features.mdx">功能介绍</a> · <a href="docs/content/docs/overview/render.mdx">Render 部署</a> · <a href="docs/content/docs/overview/docker.mdx">Docker 部署</a> · <a href="docs/content/docs/canvas/canvas-node-manual.mdx">画布节点操作手册</a> · <a href="docs/content/docs/canvas/canvas-shortcuts.mdx">画布快捷键</a> · <a href="SECURITY.md">漏洞提交</a> · <a href="docs/content/docs/progress/todo.mdx">待办事项</a> · <a href="canvas-agent/README.md">本地 Canvas Agent</a> · <a href="plugins/infinite-canvas">Codex app 插件</a>
</p>

无限画布是一款面向图片创作的开源工作台。它把画布编排、AI 图片生成、参考图编辑、对话助手、提示词库和素材沉淀放在同一个界面里，适合用来探索视觉方案并连续迭代图片结果。

> [!CAUTION]
> 项目目前处于开发阶段，不保证历史数据兼容。各种本地存储格式都可能直接调整，欢迎关注后续更新。
>
> 如果你需要稳定维护自己的分支，建议自行 fork 后独立开发。二次开发与 PR 请保留原作者信息和前端页面标识。

## 赞助商

<table>
  <tr>
    <td width="190" align="center">
      <a href="https://go.apimart.ai/gh-infinite-canvas" target="_blank" rel="noopener noreferrer"><img src="assets/apimart.png" width="163" alt="APIMart"></a>
    </td>
    <td>
      感谢 <strong><a href="https://go.apimart.ai/gh-infinite-canvas" target="_blank" rel="noopener noreferrer">APIMart</a></strong> 赞助了本项目！<strong><a href="https://go.apimart.ai/gh-infinite-canvas" target="_blank" rel="noopener noreferrer">APIMart</a></strong> 是专注 AI 图片/视频生成的低价 API 平台，GPT-Image-2 低至 <strong>$0.006/张</strong>，<strong>1 美元</strong>可出图 <strong>160+ 张</strong>。图片、视频一套异步 API 通吃，提交任务拿 ID、回调取结果，跑批万张不超时、换模型不改代码。按量付费、无月费，通过 <strong><a href="https://go.apimart.ai/gh-infinite-canvas" target="_blank" rel="noopener noreferrer">此注册链接</a></strong> 注册即可开用。
    </td>
  </tr>
  <tr>
    <td width="190" align="center">
      <a href="https://www.atlascloud.ai/zh?utm_source=github&utm_medium=link&utm_campaign=infinite-canvas" target="_blank" rel="noopener noreferrer"><img src="assets/atlascloud.svg" width="163" alt="Atlas Cloud"></a>
    </td>
    <td>
      <a href="https://www.atlascloud.ai/zh?utm_source=github&utm_medium=link&utm_campaign=infinite-canvas" target="_blank" rel="noopener noreferrer">Atlas Cloud</a> is a full-modal AI inference platform that gives developers a single AI API to access video generation, image generation, and LLM APIs. Instead of managing multiple vendor integrations, you connect once and get unified access to 300+ curated models across all modalities. Check out <a href="https://www.atlascloud.ai/console/coding-plan" target="_blank" rel="noopener noreferrer">Atlas Cloud's new coding plan promotion</a> for more budget-friendly API access.
    </td>
  </tr>
  <tr>
    <td width="190" align="center">
      <a href="https://metaso.cn/minimax-h3/?s=inf" target="_blank" rel="noopener noreferrer"><img src="assets/metaso.jpg" width="163" alt="秘塔科技"></a>
    </td>
    <td>
      <strong>MiniMax H3 视频生成 API｜秘塔科技</strong> 秘塔科技提供高性价比的 MiniMax H3 视频生成服务：<strong>768P 仅 0.09 元/秒，2K 仅 0.15 元/秒</strong>。支持原生 2K、音画同步，API 兼容 <strong>OpenAI 协议</strong>，同时支持 <strong>ComfyUI</strong>，无需自行部署 GPU。 🎁 通过 <a href="https://metaso.cn/minimax-h3/?s=inf" target="_blank" rel="noopener noreferrer">无限画布专属链接注册</a>，即可领取赠送额度及专属优惠。
    </td>
  </tr>
  <tr>
    <td width="190" align="center">
      <a href="https://88api.ai/sign-up?aff=zbs9" target="_blank" rel="noopener noreferrer"><img src="assets/88api.png" height="80" alt="88API"></a>
    </td>
    <td>
      <strong>88API｜无限画布 深度优化分支</strong>
      让主流模型能力结合得更紧密，内置海量提示词、满参满血！
      🎨&nbsp;支持 GPT-Image、Gemini、Grok 等图片模型；原生 124K 全部同价！
      🎬&nbsp;支持 Seedance、H3、Kling、Wan、Grok、Veo、omni 等视频模型；
      🎙️&nbsp;支持 Whisper、TTS、STT 等语音能力。
      从文案、出图、改图，到视频生成与配音，一张画布串联完整创作链路。不只是模型聚合，更让不同模型在同一工作流中真正协同。👉&nbsp;立即体验 🎁&nbsp;通过 <a href="https://88api.ai/sign-up?aff=zbs9" target="_blank" rel="noopener noreferrer">无限画布专属链接注册</a>，即可赠送额度及专属优惠。
    </td>
  </tr>
  <tr>
    <td width="190" align="center">
      <a href="https://www.infistar.cc/register?aff=4X3V9NA9&ref_source=link" target="_blank" rel="noopener noreferrer"><img src="assets/infistar.png" width="163" alt="Infistar.ai 无限星河"></a>
    </td>
    <td>
      <strong>无限画布 × Infistar.ai 无限星河｜内置原生画布 · 全能多模态 API</strong> 💡 原生集成，即点即用： Infistar.ai 已原生上架无限画布！同时提供低至官方 1 折的稳定 API 中转服务，模型倍率与调用明细全程透明。 🎨 多模态生图/生视频： 完美适配 Seedance、FLUX、Midjourney、Sora、Runway、Luma、可灵（Kling）等顶级图片与视频大模型。 🧠 全系语言模型： 覆盖 OpenAI、Claude、Gemini、Grok、DeepSeek、Qwen、GLM 等国内外主流模型，兼容 OpenAI 标准接口。 ⚡ 动态调度： 多路供应保障高可用，拒绝断连。 🎁 专属福利： 通过 <a href="https://infistar.ai/register?aff=4X3V9NA9&ref_source=link" target="_blank" rel="noopener noreferrer">专属链接</a> 注册，立享赠送额度/专属折扣/首充权益！
    </td>
  </tr>
  <tr>
    <td width="190" align="center">
      <a href="https://www.packyapi.com/register?aff=34VV" target="_blank" rel="noopener noreferrer"><img src="assets/packycode.png" width="163" alt="PackyCode"></a>
    </td>
    <td>
      <strong>无限画布 × PackyCode｜稳定高效的 API 中转服务商</strong>
      💡&nbsp;PackyCode 是一家稳定、高效的 API 中转服务商，提供 Claude Code、Codex、Gemini 等多种中转服务，让 AI 编程成为真正的生产力工具。
      ⚡&nbsp;稳定高效： 具备自动故障转移、智能路由和无限并发等多种功能，保障调用稳定可靠。
      🎁&nbsp;专属福利： 通过 <a href="https://www.packyapi.com/register?aff=34VV" target="_blank" rel="noopener noreferrer">专属链接</a> 注册，立即开始使用！
    </td>
  </tr>
  <tr>
    <td width="190" align="center">
      <a href="https://heyroute.ai/basketikun" target="_blank" rel="noopener noreferrer"><img src="assets/heyroute.svg" width="163" alt="HeyRoute"></a>
    </td>
    <td>
      <strong>无限画布 × HeyRoute｜全能多模态 API 服务商</strong>
      💡&nbsp;HeyRoute 深度接入无限画布，将创意构思、图片生成、视频制作与内容开发融为一体，让每个灵感都能快速落地。
      🎨&nbsp;多模态创作能力： 支持 AI 生图、生视频、图像编辑及内容生成，兼容 Seedance、MiniMax-H3、Image-2、Grok Video、Flux Klein、Gemini 等主流模型。
      🧠&nbsp;丰富模型生态： 覆盖 OpenAI、Claude、Gemini、Grok、DeepSeek、Qwen、GLM 等语言模型，并兼容 OpenAI 标准接口。
      ⚡&nbsp;稳定高效调用： 支持多模型、多线路灵活调度，调用记录清晰透明，满足日常创作、应用开发与批量生产需求。
      🎁&nbsp;专属福利： 通过 <a href="https://heyroute.ai/basketikun">专属链接</a> 注册，即可领取新用户 15 美元试用额度！
    </td>
  </tr>
</table>

## 核心功能

- 无限画布：多画布项目、节点拖拽缩放、连线、小地图、撤销重做、导入导出。
- AI 创作：浏览器前台直连你配置的 OpenAI 兼容接口，支持文生图、图生图、参考图编辑、文本问答、音频和视频生成。
- 画布助手：围绕选中节点和上游节点对话、生图，并把结果插回画布。
- 本地 Agent：通过本机 Canvas Agent 连接 Codex / Claude Code，让 Agent 通过 MCP 操作当前画布；
- Codex App 插件：提供 Codex app 插件，安装后会自动注册 MCP 并尝试拉起本地 Agent。
- 插件系统：支持通过 URL 动态安装 / 启用 / 更新 / 卸载远程节点插件，并提供 TypeScript SDK 自行开发画布节点插件。
- 自定义接口调用：可自定义生图 / 视频接口的调用方式，灵活适配各类中转站与自建服务。
- 提示词库：内置 7 个开源提示词来源并支持自定义标准 JSON 来源，由浏览器前端直连并缓存到 IndexedDB。

完整功能说明见 [功能介绍](docs/content/docs/overview/features.mdx)。

如果你在为担心没有合适的生图API来发愁，可以查看该免费生图项目：[chatgpt2api](https://github.com/basketikun/chatgpt2api)

## 快速开始

AI API Key、Base URL、画布、素材和生成记录默认保存在浏览器本地。

### 本地开发

```bash
git clone git@github.com:basketikun/infinite-canvas.git
cd infinite-canvas
cd web
bun install
bun run dev
```

### Docker 运行

```bash
git clone git@github.com:basketikun/infinite-canvas.git
cd infinite-canvas
docker compose up -d
```

运行后默认端口3000，可访问 `http://localhost:3000`。

首次打开后进入右上角配置，填入自己的 OpenAI 兼容 `Base URL` 和 `API Key`。

如果默认的OpenAI接口调用方式与您的API不同，可自定义生图/视频脚本调用。

## 效果展示

<table width="100%">
  <tr>
    <td width="50%"><img src="https://i.ibb.co/TDFvGWDT/image.png" alt="image" border="0"></td>
    <td width="50%"><img src="https://i.ibb.co/zVwJq3YS/image.png" alt="image" border="0"></td>
  </tr>
  <tr>
    <td width="50%"><img src="https://i.ibb.co/PvY3qhhK/image.png" alt="image" border="0"></td>
    <td width="50%"><img src="https://i.ibb.co/7D04LwN/image.png" alt="image" border="0"></td>
  </tr>
  <tr>
    <td width="50%"><img src="https://i.ibb.co/bj30FtS5/5.png" alt="5" border="0"></td>
    <td width="50%"><img src="https://i.ibb.co/hxRvjw51/image.png" alt="image" border="0"></td>
  </tr>
  <tr>
    <td width="50%"><img src="https://i.ibb.co/jkWsF8q1/image.png" alt="image" border="0"></td>
    <td width="50%"><img src="https://i.ibb.co/XrnfXHx7/image.png" alt="image" border="0"></td>
  </tr>
</table>

## 联系方式

项目定制二次开发需求 / 生图 API 需求可联系。

邮箱：1844025705@qq.com · QQ：1844025705

## 赞助支持

本项目长期开放广告赞助合作，欢迎品牌 / 产品投放，你的支持是持续更新的动力！

有广告赞助意向请通过上方联系方式沟通。

## 社区支持

学 AI，上 L 站：[LinuxDO](https://linux.do/)

点击链接加入群聊【开源无限画布(2群)】：https://qm.qq.com/q/HRt2kUnYiG

## 开源协议

本项目使用 [MIT License](LICENSE)。任何人都可以免费使用、复制、修改、分发、再授权和商业使用本项目，也可以用于闭源产品。

## Star History

<a href="https://www.star-history.com/?repos=basketikun%2Finfinite-canvas&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=basketikun/infinite-canvas&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=basketikun/infinite-canvas&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=basketikun/infinite-canvas&type=date&legend=top-left" />
 </picture>
</a>
