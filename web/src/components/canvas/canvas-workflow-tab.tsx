import { useCallback, useEffect, useState } from "react";
import { App, Button, Collapse, Progress, Tag, Tooltip } from "antd";
import {
    CheckCircle2,
    ChevronRight,
    CircleDashed,
    Download,
    FileCode2,
    HardDriveDownload,
    Image as ImageIcon,
    Palette,
    PauseCircle,
    RefreshCw,
    Type,
    Video,
} from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import {
    cancelModelDownload,
    fetchDownloadProgress,
    fetchWorkflows,
    formatSize,
    installWorkflow,
    startModelDownload,
    type DownloadProgress,
    type WorkflowEntry,
    type WorkflowModel,
} from "@/services/api/workflow";

const ICONS: Record<string, typeof ImageIcon> = {
    Image: ImageIcon,
    ImageEdit: Palette,
    Video: Video,
    Palette: Palette,
    Type: Type,
};

/** 「工作流」Tab：列出工作流，展开查看模型安装状态，下载模型 / 安装工作流 */
export function CanvasWorkflowTab() {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { message } = App.useApp();
    const [workflows, setWorkflows] = useState<WorkflowEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [comfyDirValid, setComfyDirValid] = useState(true);
    const [progressMap, setProgressMap] = useState<Record<string, DownloadProgress>>({}); // 每个模型各自的下载进度
    const [activeDownloads, setActiveDownloads] = useState<string[]>([]); // 正在下载的模型 file（支持多个）
    const [busyModel, setBusyModel] = useState<string | null>(null);
    const [busyWf, setBusyWf] = useState<string | null>(null);
    const [activeKeys, setActiveKeys] = useState<string[]>([]);

    const load = useCallback(async () => {
        setLoading(true);
        setLoadError(null);
        try {
            const data = await fetchWorkflows();
            setWorkflows(data.workflows);
            setComfyDirValid(data.comfyDirValid);
        } catch (e) {
            setLoadError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    // 下载轮询：由 activeDownloads 驱动（并发，一次拉取全部任务进度）
    useEffect(() => {
        if (activeDownloads.length === 0) return;
        let stopped = false;
        const tick = async () => {
            try {
                const { tasks } = await fetchDownloadProgress();
                if (stopped) return;
                setProgressMap(tasks);
                // 找出本次跟踪任务中已结束的，逐个收尾
                const finished = activeDownloads.filter((f) => {
                    const p = tasks[f];
                    return p && (p.status === "done" || p.status === "error" || p.status === "canceled");
                });
                if (finished.length > 0) {
                    setActiveDownloads((prev) => prev.filter((f) => !finished.includes(f)));
                    void load();
                    for (const f of finished) {
                        const p = tasks[f];
                        const name = f.split("/").pop();
                        if (p.status === "done") message.success(`下载完成：${name}`);
                        else if (p.status === "error") message.error(`下载失败：${name} ${p.error || ""}`);
                    }
                }
            } catch {
                /* 忽略瞬时错误 */
            }
        };
        void tick();
        const timer = setInterval(tick, 600);
        return () => { stopped = true; clearInterval(timer); };
    }, [activeDownloads, load, message]);

    const handleDownload = async (wf: WorkflowEntry, model: WorkflowModel) => {
        setBusyModel(model.file);
        try {
            const result = await startModelDownload(model);
            if (result.ok === false) {
                message.warning(result.message || "该文件已在下载队列中");
                return;
            }
            // 立即进入轮询，进度条马上出现在该模型卡片下方
            setProgressMap((prev) => ({
                ...prev,
                [model.file]: { status: "queued", file: model.file, downloaded: model.localSize || 0, total: model.sizeBytes || 0, percentage: 0, speed: 0 },
            }));
            setActiveDownloads((prev) => (prev.includes(model.file) ? prev : [...prev, model.file]));
            // 自动展开所属工作流，保证进度条可见
            setActiveKeys((keys) => (keys.includes(wf.id) ? keys : [...keys, wf.id]));
        } catch (e) {
            message.error(`启动下载失败：${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setBusyModel(null);
        }
    };

    const handleCancel = async (file: string) => {
        try {
            await cancelModelDownload(file);
            message.info("已取消，未下载完成的部分会在下次下载时自动续传");
        } catch (e) {
            message.error(`取消失败：${e instanceof Error ? e.message : String(e)}`);
        }
    };

    const handleInstallWf = async (wf: WorkflowEntry) => {
        setBusyWf(wf.id);
        try {
            await installWorkflow(wf);
            message.success(`已安装工作流：${wf.name}`);
            void load();
        } catch (e) {
            message.error(`安装工作流失败：${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setBusyWf(null);
        }
    };

    const renderModel = (wf: WorkflowEntry, model: WorkflowModel) => {
        const progress = progressMap[model.file];
        const isThisDownloading = activeDownloads.includes(model.file);
        const showBar = isThisDownloading && (progress?.status === "queued" || progress?.status === "downloading");
        const canDownload = wf.status === "available" && !model.installed && model.repo;
        return (
            <div key={model.file} className="space-y-1.5">
                <div
                    className="flex items-center gap-2 rounded-lg border px-3 py-2"
                    style={{ borderColor: theme.node.stroke, background: theme.node.fill }}
                >
                    {model.installed ? (
                        <CheckCircle2 className="size-4 shrink-0" style={{ color: "#22c55e" }} />
                    ) : model.partial ? (
                        <PauseCircle className="size-4 shrink-0" style={{ color: "#f59e0b" }} />
                    ) : (
                        <CircleDashed className="size-4 shrink-0" style={{ color: theme.node.muted }} />
                    )}
                    <div className="min-w-0 flex-1">
                        <div className="truncate text-xs" style={{ color: theme.node.text }}>
                            <span style={{ color: theme.node.muted }}>{model.role} · </span>
                            {model.file.split("/").pop()}
                        </div>
                        <div className="mt-0.5 text-[11px]" style={{ color: model.partial ? "#f59e0b" : theme.node.muted }}>
                            {model.installed
                                ? `已安装${model.localSize ? ` · ${formatSize(model.localSize)}` : ""}`
                                : model.partial
                                    ? `断点续传 · 已下载 ${formatSize(model.localSize)}${model.sizeBytes ? ` / ${formatSize(model.sizeBytes)}` : ""}`
                                    : `未安装 · 需 ${formatSize(model.sizeBytes)}`}
                        </div>
                    </div>
                    {canDownload && (
                        <Tooltip title={model.partial ? "继续下载（断点续传）" : "从 ModelScope 下载"}>
                            <Button
                                type="text"
                                size="small"
                                icon={model.partial ? <HardDriveDownload className="size-4" /> : <Download className="size-4" />}
                                loading={busyModel === model.file}
                                disabled={isThisDownloading}
                                onClick={() => void handleDownload(wf, model)}
                            />
                        </Tooltip>
                    )}
                </div>
                {/* 下载进度条：直接显示在对应模型卡片下方 */}
                {showBar && (
                    <div className="rounded-lg border px-3 py-2" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}>
                        <div className="flex items-center gap-2">
                            <Download className="size-3.5 shrink-0" style={{ color: "#3b82f6" }} />
                            <div className="min-w-0 flex-1">
                                <Progress percent={progress?.percentage || 0} size="small" showInfo={false} style={{ margin: 0 }} />
                            </div>
                            <span className="shrink-0 text-[11px] tabular-nums" style={{ color: theme.node.text }}>{progress?.percentage || 0}%</span>
                            <Button size="small" danger onClick={() => void handleCancel(model.file)}>取消</Button>
                        </div>
                        <div className="mt-1 flex items-center justify-between text-[10px]" style={{ color: theme.node.muted }}>
                            <span className="tabular-nums">
                                {progress?.status === "queued" ? "排队中…" : `${formatSize(progress?.downloaded)} / ${formatSize(progress?.total)}`}
                            </span>
                            <span className="tabular-nums">
                                {progress?.speed ? `${progress.speed} MB/s` : "正在连接…"}
                                {model.partial || (progress?.downloaded || 0) > 0 ? " · 支持断点续传" : ""}
                            </span>
                        </div>
                    </div>
                )}
            </div>
        );
    };

    const collapseItems = workflows.map((wf) => {
        const Icon = ICONS[wf.icon || ""] || ImageIcon;
        // 动态判断：可扩展工作流在模型齐全且工作流已安装后，也视为「已集成」
        const integrated = wf.status === "existing" || (wf.allInstalled && !!wf.workflowInstalled);
        const badgeColor = integrated ? "#22c55e" : "#f59e0b";
        const badgeText = integrated ? "已集成" : "可扩展";
        return {
            key: wf.id,
            label: (
                <div className="flex items-center gap-3.5 py-1">
                    <span className="grid size-10 shrink-0 place-items-center rounded-xl" style={{ background: theme.toolbar.activeBg, color: theme.node.muted }}>
                        <Icon className="size-[18px]" />
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium" style={{ color: theme.node.text }}>{wf.name}</span>
                            <Tag className="!m-0 !text-[10px]" color={integrated ? "success" : "warning"}>{badgeText}</Tag>
                        </div>
                        <div className="mt-0.5 truncate text-xs" style={{ color: theme.node.muted }}>
                            {wf.installedCount}/{wf.totalCount} 个模型就绪
                        </div>
                    </div>
                    <span className="size-2.5 shrink-0 rounded-full" style={{ background: wf.allInstalled ? "#22c55e" : badgeColor }} title={wf.allInstalled ? "模型齐全" : "缺少模型"} />
                </div>
            ),
            children: (
                <div className="space-y-3 pb-1 pl-3">
                    <div className="text-xs leading-5" style={{ color: theme.node.muted }}>{wf.description}</div>
                    <div className="space-y-2">
                        {wf.models.map((m) => renderModel(wf, m))}
                    </div>
                    {wf.status === "available" && (
                        <div className="flex items-center gap-2 pt-1">
                            {wf.workflowInstalled ? (
                                <Tag color="success" className="!m-0">工作流已安装</Tag>
                            ) : (
                                <Button
                                    size="small"
                                    type="primary"
                                    icon={<FileCode2 className="size-4" />}
                                    loading={busyWf === wf.id}
                                    onClick={() => void handleInstallWf(wf)}
                                >
                                    安装工作流
                                </Button>
                            )}
                            <span className="text-[11px]" style={{ color: theme.node.muted }}>安装后可在 ComfyUI 的工作流列表中使用</span>
                        </div>
                    )}
                </div>
            ),
        };
    });

    return (
        <div className="space-y-3">
            {!comfyDirValid && (
                <div className="rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "#f59e0b55", background: "#f59e0b14", color: theme.node.text }}>
                    未找到 ComfyUI 模型目录，请确认网关的 COMFY_DIR 指向 ComfyUI 根目录。
                </div>
            )}
            <div className="flex items-center justify-between">
                <div className="text-xs" style={{ color: theme.node.muted }}>
                    展开查看每个工作流所需模型与安装状态，缺失的可直接从 ModelScope 下载（支持断点续传）。
                </div>
                <Button type="text" size="small" icon={<RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />} onClick={() => void load()} disabled={loading}>
                    刷新
                </Button>
            </div>

            {loadError ? (
                <div className="rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "#ef444455", background: "#ef444414", color: theme.node.text }}>
                    加载失败：{loadError}
                </div>
            ) : loading && workflows.length === 0 ? (
                <div className="py-10 text-center text-sm" style={{ color: theme.node.muted }}>正在读取工作流…</div>
            ) : (
                <div className="thin-scrollbar max-h-[64vh] overflow-auto pr-1">
                    <Collapse
                        activeKey={activeKeys}
                        onChange={(keys) => setActiveKeys(Array.isArray(keys) ? keys : [keys])}
                        items={collapseItems}
                        ghost
                        className="workflow-collapse"
                        expandIcon={({ isActive }) => (
                            <span
                                className={`grid size-6 shrink-0 place-items-center rounded-lg transition-transform duration-200 ${isActive ? "rotate-90" : ""}`}
                                style={{ background: theme.toolbar.activeBg }}
                            >
                                <ChevronRight className="size-3.5 !text-current" strokeWidth={2.5} style={{ color: theme.node.text }} />
                            </span>
                        )}
                    />
                </div>
            )}
        </div>
    );
}
