import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Trash2 } from "lucide-react";
import { Button, Popover, Tooltip } from "antd";

import { useConfigStore } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

type Stats = {
  ram: { total: number; free: number; used: number };
  vram: { total: number; free: number; used: number };
  device: string;
  queue: number;
};

function fmt(n: number) {
  return (n / 1e9).toFixed(1);
}

function pct(used: number, total: number) {
  return total > 0 ? Math.round((used / total) * 100) : 0;
}

function barColor(p: number) {
  if (p >= 85) return "#ef4444";
  if (p >= 65) return "#f59e0b";
  return "#22c55e";
}

/** 从渠道配置推导网关根地址（去掉 /v1），系统接口挂在网关根路径下 */
function gatewayRoot(): string {
  try {
    const channels = useConfigStore.getState().config.channels || [];
    const local = channels.find((c) => /127\.0\.0\.1:8190|localhost:8190/i.test(c.baseUrl)) || channels[0];
    let base = (local?.baseUrl || "http://127.0.0.1:8190/v1").trim().replace(/\/+$/, "");
    base = base.replace(/\/v1$/i, "");
    return base;
  } catch {
    return "http://127.0.0.1:8190";
  }
}

/** 画布顶栏：内存/显存占用显示 + 一键清理 */
export function CanvasResourceMonitor() {
  const colorTheme = useThemeStore((state) => state.theme);
  const theme = canvasThemes[colorTheme];
  const [stats, setStats] = useState<Stats | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const mountedRef = useRef(true);
  const rootRef = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const fetchStats = useCallback(async () => {
    try {
      const r = await fetch(`${gatewayRoot()}/system/stats`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      if (mountedRef.current) {
        setStats(data);
        setError("");
      }
    } catch {
      if (mountedRef.current) setError("离线");
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void fetchStats();
    const timer = window.setInterval(() => void fetchStats(), 5000);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
    };
  }, [fetchStats]);

  // 点击弹窗内容区(rigger/popover)之外的任何位置就关闭。
  // 用捕获阶段，确保画布 stopPropagation 的点击也能触发关闭。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const clean = useCallback(async () => {
    if (cleaning) return;
    setCleaning(true);
    try {
      const r = await fetch(`${gatewayRoot()}/system/free`, { method: "POST", signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      if (mountedRef.current) setStats(data);
    } catch (e) {
      if (mountedRef.current) setError("清理失败");
    } finally {
      if (mountedRef.current) setCleaning(false);
    }
  }, [cleaning]);

  const ramP = stats ? pct(stats.ram.used, stats.ram.total) : 0;
  const vramP = stats ? pct(stats.vram.used, stats.vram.total) : 0;

  const detail = (
    <div ref={popRef} className="w-64 space-y-3 p-1 text-xs" style={{ color: theme.node.text }}>
      <div className="flex items-center justify-between font-medium">
        <span>资源占用</span>
        <span className="opacity-50">{stats?.device ? String(stats.device).replace(/cuda:0\s*/i, "") : error || ""}</span>
      </div>
      <Metric label="显存 VRAM" used={stats?.vram.used || 0} total={stats?.vram.total || 0} percent={vramP} />
      <Metric label="内存 RAM" used={stats?.ram.used || 0} total={stats?.ram.total || 0} percent={ramP} />
      <div className="flex items-center justify-between border-t pt-2" style={{ borderColor: theme.node.stroke }}>
        <span className="opacity-60">待处理任务</span>
        <span>{stats?.queue ?? 0}</span>
      </div>
      <Button block danger type="primary" size="small" loading={cleaning} icon={<Trash2 className="size-3.5" />} onClick={() => void clean()}>
        {cleaning ? "清理中…" : "一键清理显存 / 卸载模型"}
      </Button>
      <div className="opacity-45">清理会卸载 ComfyUI 已加载的模型并释放显存，下次生成会重新加载（约几十秒）。</div>
    </div>
  );

  return (
    <span ref={rootRef} className="inline-flex">
      <Popover content={detail} trigger="click" placement="bottomRight" open={open} onOpenChange={setOpen}>
        <button
          type="button"
          className="flex h-8 items-center gap-1.5 rounded-full px-2.5 text-xs transition hover:bg-black/5 dark:hover:bg-white/10"
          style={{ color: theme.node.text }}
          title="内存 / 显存占用 · 点击查看详情与清理"
        >
          <Activity className="size-3.5" />
          {error ? (
            <span className="opacity-50">{error}</span>
          ) : stats ? (
            <span className="flex items-center gap-2 font-mono tabular-nums">
              <span title="显存">GPU <b style={{ color: barColor(vramP) }}>{vramP}%</b></span>
              <span className="opacity-30">·</span>
              <span title="内存">RAM <b style={{ color: barColor(ramP) }}>{ramP}%</b></span>
            </span>
          ) : (
            <span className="opacity-50">…</span>
          )}
        </button>
      </Popover>
    </span>
  );
}

function Metric({ label, used, total, percent }: { label: string; used: number; total: number; percent: number }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span>{label}</span>
        <span className="font-mono tabular-nums opacity-80">{fmt(used)} / {fmt(total)} GB</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: "rgba(120,113,108,.2)" }}>
        <div className="h-full rounded-full transition-all" style={{ width: `${percent}%`, background: barColor(percent) }} />
      </div>
    </div>
  );
}
