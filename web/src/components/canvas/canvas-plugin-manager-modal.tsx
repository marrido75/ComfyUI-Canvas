import { Modal } from "antd";
import { useTranslation } from "react-i18next";

import { CanvasPluginPanel } from "@/components/canvas/canvas-plugin-panel";

/** 独立的节点插件弹窗：由画布顶部工具栏拼图图标打开。面板内容复用 CanvasPluginPanel。 */
export function CanvasPluginManagerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { t } = useTranslation();
    return (
        <Modal title={t("canvas.plugins.title")} open={open} onCancel={onClose} footer={null} centered width={640} destroyOnHidden>
            <CanvasPluginPanel active={open} />
        </Modal>
    );
}
