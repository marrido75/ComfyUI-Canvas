import { useEffect, useState } from "react";
import { Input, InputNumber, Modal } from "antd";

import { readImageMeta } from "@/lib/image-utils";

export type CanvasImageOutpaintPayload = {
    left: number;
    right: number;
    top: number;
    bottom: number;
    prompt: string;
};

/** 扩图参数对话框：输入左右上下扩展像素 + 可选描述，实时显示扩展后尺寸 */
export function CanvasNodeOutpaintDialog({
    dataUrl,
    open,
    onClose,
    onConfirm,
}: {
    dataUrl: string;
    open: boolean;
    onClose: () => void;
    onConfirm: (payload: CanvasImageOutpaintPayload) => void;
}) {
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const [left, setLeft] = useState(256);
    const [right, setRight] = useState(256);
    const [top, setTop] = useState(0);
    const [bottom, setBottom] = useState(0);
    const [prompt, setPrompt] = useState("");

    useEffect(() => {
        if (!open) return;
        setLeft(256);
        setRight(256);
        setTop(0);
        setBottom(0);
        setPrompt("");
        void readImageMeta(dataUrl).then(setImage);
    }, [dataUrl, open]);

    const outW = (image?.width || 0) + left + right;
    const outH = (image?.height || 0) + top + bottom;

    const handleOk = () => {
        onConfirm({ left, right, top, bottom, prompt: prompt.trim() });
    };

    return (
        <Modal
            title="扩图（外补画面）"
            open={open}
            onCancel={onClose}
            onOk={handleOk}
            okText="开始扩图"
            cancelText="取消"
            centered
            width={560}
            destroyOnHidden
        >
            <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
                {dataUrl ? (
                    <img
                        src={dataUrl}
                        alt="源图预览"
                        style={{ width: 160, height: 160, objectFit: "contain", border: "1px solid #ddd", borderRadius: 6, background: "#f5f5f5" }}
                    />
                ) : null}
                <div style={{ flex: 1, fontSize: 13, lineHeight: 2 }}>
                    <div>源图尺寸：{image ? `${image.width} × ${image.height}` : "读取中…"}</div>
                    <div>扩展后尺寸：<b style={{ color: "#1677ff" }}>{outW || "—"} × {outH || "—"}</b></div>
                    <div style={{ color: "#888", fontSize: 12 }}>像素值需为 8 的倍数效果最佳；扩图会用 AI 自然补全新增区域。</div>
                </div>
            </div>

            <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 20px" }}>
                <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span>向左扩展 (px)</span>
                    <InputNumber min={0} max={2048} step={64} value={left} onChange={(v) => setLeft(v || 0)} style={{ width: 110 }} />
                </label>
                <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span>向右扩展 (px)</span>
                    <InputNumber min={0} max={2048} step={64} value={right} onChange={(v) => setRight(v || 0)} style={{ width: 110 }} />
                </label>
                <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span>向上扩展 (px)</span>
                    <InputNumber min={0} max={2048} step={64} value={top} onChange={(v) => setTop(v || 0)} style={{ width: 110 }} />
                </label>
                <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span>向下扩展 (px)</span>
                    <InputNumber min={0} max={2048} step={64} value={bottom} onChange={(v) => setBottom(v || 0)} style={{ width: 110 }} />
                </label>
            </div>

            <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 13, marginBottom: 6 }}>扩展区域描述（可选）</div>
                <Input.TextArea
                    rows={2}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="例如：延续背景的米色墙面与柔和光影"
                />
            </div>
        </Modal>
    );
}
