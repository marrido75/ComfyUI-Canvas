import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Input, InputNumber, Modal } from "antd";

import { readImageMeta } from "@/lib/image-utils";

export type CanvasImageOutpaintPayload = {
    left: number;
    right: number;
    top: number;
    bottom: number;
    prompt: string;
};

type Side = "left" | "right" | "top" | "bottom";

const VIEW_W = 336;
const VIEW_H = 248;
const MAX_EXTEND = 2048;

const clamp = (v: number) => Math.max(0, Math.min(MAX_EXTEND, v));
const snap = (v: number) => Math.round(v / 8) * 8; // 吸附到 8 的倍数，保证 latent 对齐

/** 扩图参数对话框：在预览上直接拖拽四边调整扩展范围，并与数字输入双向同步 */
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

    // 拖拽期间锁定缩放比例，保证画板不跳动、只动边缘
    const [lockScale, setLockScale] = useState<number | null>(null);
    const dragRef = useRef<{
        side: Side;
        startX: number;
        startY: number;
        startLeft: number;
        startRight: number;
        startTop: number;
        startBottom: number;
        scale: number;
    } | null>(null);

    useEffect(() => {
        if (!open) return;
        setLeft(256);
        setRight(256);
        setTop(0);
        setBottom(0);
        setPrompt("");
        setLockScale(null);
        dragRef.current = null;
        void readImageMeta(dataUrl).then(setImage);
    }, [dataUrl, open]);

    const outW = (image?.width || 0) + left + right;
    const outH = (image?.height || 0) + top + bottom;

    // 让 源图+扩展区 完整放进预览视口
    const baseScale = image ? Math.min(VIEW_W / outW, VIEW_H / outH, 1) : 1;
    const scale = lockScale ?? baseScale;
    const boardW = outW * scale;
    const boardH = outH * scale;
    const imgW = (image?.width || 0) * scale;
    const imgH = (image?.height || 0) * scale;

    const startDrag = (side: Side, e: ReactPointerEvent<HTMLDivElement>) => {
        if (!image) return;
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        dragRef.current = {
            side,
            startX: e.clientX,
            startY: e.clientY,
            startLeft: left,
            startRight: right,
            startTop: top,
            startBottom: bottom,
            scale,
        };
        setLockScale(scale);
    };

    const onDragMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        const d = dragRef.current;
        if (!d) return;
        e.preventDefault();
        const dx = (e.clientX - d.startX) / d.scale; // 换算成源图像素
        const dy = (e.clientY - d.startY) / d.scale;
        if (d.side === "left") setLeft(clamp(snap(d.startLeft - dx)));
        if (d.side === "right") setRight(clamp(snap(d.startRight + dx)));
        if (d.side === "top") setTop(clamp(snap(d.startTop - dy)));
        if (d.side === "bottom") setBottom(clamp(snap(d.startBottom + dy)));
    };

    const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (!dragRef.current) return;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
        dragRef.current = null;
        setLockScale(null);
    };

    const handleOk = () => {
        onConfirm({ left, right, top, bottom, prompt: prompt.trim() });
    };

    const handleProps = (side: Side) => ({
        onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => startDrag(side, e),
        onPointerMove: onDragMove,
        onPointerUp: endDrag,
        onPointerCancel: endDrag,
    });

    return (
        <Modal
            title="扩图（外补画面）"
            open={open}
            onCancel={onClose}
            onOk={handleOk}
            okText="开始扩图"
            cancelText="取消"
            centered
            width={660}
            destroyOnHidden
        >
            <div style={{ display: "flex", gap: 18, alignItems: "flex-start" }}>
                <div>
                    <div
                        style={{
                            position: "relative",
                            width: VIEW_W,
                            height: VIEW_H,
                            background: "#111827",
                            borderRadius: 6,
                            overflow: "hidden",
                            border: "1px solid #374151",
                            flexShrink: 0,
                        }}
                    >
                        <div
                            style={{
                                position: "absolute",
                                left: (VIEW_W - boardW) / 2,
                                top: (VIEW_H - boardH) / 2,
                                width: boardW,
                                height: boardH,
                            }}
                        >
                            {/* 扩展区域（AI 补全区） */}
                            <div
                                style={{
                                    position: "absolute",
                                    inset: 0,
                                    background:
                                        "repeating-linear-gradient(45deg, rgba(96,165,250,0.14) 0 8px, rgba(96,165,250,0.05) 8px 16px)",
                                    border: "1px dashed rgba(147,197,253,0.75)",
                                    boxSizing: "border-box",
                                }}
                            />
                            {/* 源图 */}
                            <img
                                src={dataUrl}
                                alt="源图预览"
                                draggable={false}
                                style={{
                                    position: "absolute",
                                    left: left * scale,
                                    top: top * scale,
                                    width: imgW,
                                    height: imgH,
                                    objectFit: "fill",
                                    boxShadow: "0 0 0 1px rgba(255,255,255,0.55)",
                                    userSelect: "none",
                                    pointerEvents: "none",
                                }}
                            />
                            {/* 四条可拖拽边 */}
                            <div
                                title="拖动调整向左扩展"
                                {...handleProps("left")}
                                style={{ position: "absolute", left: 0, top: 0, width: 12, height: boardH, cursor: "ew-resize", touchAction: "none" }}
                            >
                                <div style={{ position: "absolute", left: 3, top: boardH / 2 - 16, width: 6, height: 32, borderRadius: 3, background: "#3b82f6", opacity: 0.95 }} />
                            </div>
                            <div
                                title="拖动调整向右扩展"
                                {...handleProps("right")}
                                style={{ position: "absolute", right: 0, top: 0, width: 12, height: boardH, cursor: "ew-resize", touchAction: "none" }}
                            >
                                <div style={{ position: "absolute", right: 3, top: boardH / 2 - 16, width: 6, height: 32, borderRadius: 3, background: "#3b82f6", opacity: 0.95 }} />
                            </div>
                            <div
                                title="拖动调整向上扩展"
                                {...handleProps("top")}
                                style={{ position: "absolute", left: 0, top: 0, width: boardW, height: 12, cursor: "ns-resize", touchAction: "none" }}
                            >
                                <div style={{ position: "absolute", left: boardW / 2 - 16, top: 3, width: 32, height: 6, borderRadius: 3, background: "#3b82f6", opacity: 0.95 }} />
                            </div>
                            <div
                                title="拖动调整向下扩展"
                                {...handleProps("bottom")}
                                style={{ position: "absolute", left: 0, bottom: 0, width: boardW, height: 12, cursor: "ns-resize", touchAction: "none" }}
                            >
                                <div style={{ position: "absolute", left: boardW / 2 - 16, bottom: 3, width: 32, height: 6, borderRadius: 3, background: "#3b82f6", opacity: 0.95 }} />
                            </div>
                        </div>
                    </div>
                    <div style={{ color: "#888", fontSize: 11, marginTop: 4, textAlign: "center" }}>
                        拖拽蓝色手柄调整扩展范围（按 8px 吸附）
                    </div>
                </div>
                <div style={{ flex: 1, fontSize: 13, lineHeight: 2 }}>
                    <div>源图尺寸：{image ? `${image.width} × ${image.height}` : "读取中…"}</div>
                    <div>扩展后尺寸：<b style={{ color: "#1677ff" }}>{outW || "—"} × {outH || "—"}</b></div>
                    <div style={{ color: "#888", fontSize: 12 }}>像素值需为 8 的倍数效果最佳；扩图会用 AI 自然补全新增区域。</div>
                </div>
            </div>

            <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 20px" }}>
                <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span>向左扩展 (px)</span>
                    <InputNumber min={0} max={MAX_EXTEND} step={8} value={left} onChange={(v) => setLeft(clamp(v || 0))} style={{ width: 110 }} />
                </label>
                <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span>向右扩展 (px)</span>
                    <InputNumber min={0} max={MAX_EXTEND} step={8} value={right} onChange={(v) => setRight(clamp(v || 0))} style={{ width: 110 }} />
                </label>
                <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span>向上扩展 (px)</span>
                    <InputNumber min={0} max={MAX_EXTEND} step={8} value={top} onChange={(v) => setTop(clamp(v || 0))} style={{ width: 110 }} />
                </label>
                <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span>向下扩展 (px)</span>
                    <InputNumber min={0} max={MAX_EXTEND} step={8} value={bottom} onChange={(v) => setBottom(clamp(v || 0))} style={{ width: 110 }} />
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
