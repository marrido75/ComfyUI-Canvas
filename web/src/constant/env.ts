export const APP_VERSION = __APP_VERSION__ || "dev";

// 版本更新数据源：默认指向本地网关（提供你自己的版本信息），可通过 VITE_VERSION_URL / VITE_CHANGELOG_URL 覆盖成任意地址。
// 若要用官方仓库，把两个环境变量分别设为：
//   https://raw.githubusercontent.com/basketikun/infinite-canvas/main/VERSION
//   https://raw.githubusercontent.com/basketikun/infinite-canvas/main/CHANGELOG.md
// 网关提供 GET /version 和 GET /changelog，读取项目根目录的 VERSION / CHANGELOG.md 返回纯文本。
export const VERSION_URL = import.meta.env.VITE_VERSION_URL || "http://127.0.0.1:8190/version";
export const CHANGELOG_URL = import.meta.env.VITE_CHANGELOG_URL || "http://127.0.0.1:8190/changelog";

export const DOCS_URL = import.meta.env.VITE_DOC_URL || "https://docs.canvas.best";

// Official plugin registry URL: CI publishes to plugins-dist for jsDelivr delivery; an environment variable may override it for self-hosting.
export const PLUGIN_REGISTRY_URL = import.meta.env.VITE_PLUGIN_REGISTRY_URL || "https://cdn.jsdelivr.net/gh/basketikun/infinite-canvas@plugins-dist/official-plugins.json";
