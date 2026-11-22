import { Modal } from "antd";
import { Workflow } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CanvasWorkflowTab } from "@/components/canvas/canvas-workflow-tab";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

/** 独立的工作流弹窗：由画布顶部工具栏的工作流图标打开 */
export function CanvasWorkflowModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return (
        <Modal
            title={
                <span className="inline-flex items-center gap-2">
                    <Workflow className="size-4" style={{ color: theme.node.text }} />
                    {t("canvas.plugins.workflow")}
                </span>
            }
            open={open}
            onCancel={onClose}
            footer={null}
            centered
            width={920}
            styles={{ body: { paddingTop: 8 } }}
            destroyOnHidden
        >
            <CanvasWorkflowTab />
        </Modal>
    );
}
