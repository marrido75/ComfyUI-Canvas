import axios from "axios";

import { useConfigStore, type AiConfig } from "@/stores/use-config-store";

export type WorkflowModel = {
    role: string;
    file: string;
    sizeBytes?: number;
    repo?: string;
    remotePath?: string;
    installed: boolean;
    localSize?: number;
    localPath?: string;
    partial?: boolean; // 半成品：文件存在但不完整，可断点续传
};

export type WorkflowEntry = {
    id: string;
    name: string;
    nameEn?: string;
    description?: string;
    status: "existing" | "available";
    icon?: string;
    workflowUrl?: string;
    workflowFile?: string;
    workflowInstalled?: boolean;
    models: WorkflowModel[];
    installedCount: number;
    totalCount: number;
    allInstalled: boolean;
};

export type WorkflowList = {
    workflows: WorkflowEntry[];
    comfyDir: string;
    comfyDirValid: boolean;
};

export type DownloadProgress = {
    status: "idle" | "queued" | "downloading" | "done" | "canceled" | "error";
    file: string | null;
    downloaded: number;
    total: number;
    percentage: number;
    speed: number; // MB/s
    error?: string | null;
};

export type DownloadProgressList = {
    tasks: Record<string, DownloadProgress>; // key 为模型 file
    latest: string | null;
};

/** 找到本地网关（8190）的 baseUrl；找不到则用默认地址 */
function gatewayBase(config: AiConfig): string {
    for (const channel of config.channels || []) {
        const base = (channel.baseUrl || "").toLowerCase();
        if (base.includes("8190") || base.includes("local-comfyui")) {
            return channel.baseUrl.replace(/\/+$/, "");
        }
    }
    return "http://127.0.0.1:8190";
}

function apiBase(): string {
    const config = useConfigStore.getState().config;
    const base = gatewayBase(config).replace(/\/+$/, "");
    return base.endsWith("/v1") ? base : `${base}/v1`;
}

export async function fetchWorkflows(): Promise<WorkflowList> {
    const { data } = await axios.get<WorkflowList>(`${apiBase()}/workflows`, { timeout: 15000 });
    return data;
}

/** 从 /v1/models 拉取网关当前就绪的图片模型 id（模型齐全+工作流存在才 ready）。 */
export async function fetchReadyImageModelIds(): Promise<string[]> {
    const { data } = await axios.get<{ data?: Array<{ id?: string; ready?: boolean }> }>(`${apiBase()}/models`, { timeout: 8000 });
    return (data?.data || []).filter((m) => m.ready === true && m.id).map((m) => m.id as string);
}

export async function fetchDownloadProgress(): Promise<DownloadProgressList> {
    const { data } = await axios.get<DownloadProgressList>(`${apiBase()}/models/download/progress`, { timeout: 8000 });
    return data;
}

export async function startModelDownload(model: WorkflowModel): Promise<{ ok: boolean; reason?: string; message?: string }> {
    if (!model.repo || !model.remotePath) throw new Error("该模型没有配置下载源");
    const { data } = await axios.post(
        `${apiBase()}/models/download`,
        { file: model.file, repo: model.repo, remotePath: model.remotePath, sizeBytes: model.sizeBytes },
        { timeout: 15000 },
    );
    return data || { ok: true };
}

export async function cancelModelDownload(file?: string): Promise<void> {
    await axios.post(`${apiBase()}/models/download/cancel`, file ? { file } : {}, { timeout: 8000 });
}

export async function installWorkflow(entry: WorkflowEntry): Promise<void> {
    if (!entry.workflowUrl || !entry.workflowFile) throw new Error("该工作流没有配置安装地址");
    await axios.post(
        `${apiBase()}/workflows/install`,
        { workflowUrl: entry.workflowUrl, workflowFile: entry.workflowFile },
        { timeout: 90000 },
    );
}

/** 人类可读的文件大小 */
export function formatSize(bytes?: number): string {
    if (!bytes || bytes <= 0) return "—";
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
}
