import { create } from 'zustand';

// src/stores/useExternalMediaSettingsStore.ts
// "设置 → 外部媒体"面板的设置镜像（功能性设置；真正的持久化在主进程，见 electron/main.cjs）。
//
// 为什么需要一份 store 而不是面板自己各读各的：开关与令牌轮换有**两个**入口（设置面板、
// 命令面板），两条 IPC 各读各的必然出现"命令切了、面板还显示旧值"的分叉。这里是唯一的镜像。
//
// 判据不在此处：可用性六态照旧由 utils/externalMediaStatus.ts 决定，本 store 只持有设置本身
// （enabled / port / token）。默认关闭由主进程的默认值保证，这里不重复声明。

type ExternalMediaSettingsState = {
    settings: ElectronExternalMediaSettings | null;
    /** 切换 / 轮换进行中（按钮禁用用）。 */
    busy: boolean;
    loadSettings: () => Promise<void>;
    setEnabled: (enabled: boolean) => Promise<void>;
    regenerateToken: () => Promise<void>;
};

const readBridge = () => (typeof window !== 'undefined' ? window.electron : undefined);

export const useExternalMediaSettingsStore = create<ExternalMediaSettingsState>(set => ({
    settings: null,
    busy: false,
    loadSettings: async () => {
        const bridge = readBridge();
        if (typeof bridge?.externalMediaSettingsGet !== 'function') return;
        try {
            set({ settings: await bridge.externalMediaSettingsGet() });
        } catch {
            // 非 Electron / IPC 故障：面板保持"未知"即可，不为此打扰用户。
        }
    },
    setEnabled: async (enabled) => {
        const bridge = readBridge();
        if (typeof bridge?.externalMediaSettingsSet !== 'function') return;
        set({ busy: true });
        try {
            set({ settings: await bridge.externalMediaSettingsSet({ enabled }) });
        } finally {
            set({ busy: false });
        }
    },
    regenerateToken: async () => {
        const bridge = readBridge();
        if (typeof bridge?.externalMediaTokenRegenerate !== 'function') return;
        set({ busy: true });
        try {
            set({ settings: await bridge.externalMediaTokenRegenerate() });
        } finally {
            set({ busy: false });
        }
    },
}));

/**
 * 命令面板等非渲染路径的"翻转开关"入口。返回翻转后的 enabled，`null` 表示通道不存在
 * （非 Electron 窗口），调用方应把命令报为不可用而不是假装成功。
 */
export const toggleExternalMediaEnabled = async (): Promise<boolean | null> => {
    const bridge = readBridge();
    if (
        typeof bridge?.externalMediaSettingsGet !== 'function'
        || typeof bridge?.externalMediaSettingsSet !== 'function'
    ) {
        return null;
    }
    const current = await bridge.externalMediaSettingsGet();
    const next = await bridge.externalMediaSettingsSet({ enabled: !current.enabled });
    useExternalMediaSettingsStore.setState({ settings: next });
    return next.enabled;
};
