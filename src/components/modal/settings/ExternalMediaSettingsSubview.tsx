import React, { useEffect, useState } from 'react';
import { Cast, Check, KeyRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ExternalMediaAvailability } from '../../../types/playbackBackend';
import { useExternalMediaSettingsStore } from '../../../stores/useExternalMediaSettingsStore';
import { useExternalMediaStore } from '../../../stores/useExternalMediaStore';
import { setStatusMessage } from '../../../stores/useStatusMessageStore';
import { resolveExternalMediaAvailability } from '../../../utils/externalMediaStatus';
import type { IntegrationSettingsChrome } from './IntegrationSettingsSubview';
import { SettingsAnchor } from './navigation/SettingsAnchorContext';
import SettingsSectionHeading from './navigation/SettingsSectionHeading';

// src/components/modal/settings/ExternalMediaSettingsSubview.tsx
// "设置 → 外部媒体"面板：外部媒体后端（Chrome 里的 music.apple.com 全曲播放）的全部用户设置。
//
// 三件事，别处都没有：
//   1. 启用开关（默认关）——它在主进程直接闸掉两个桥（helper 进程 + loopback 服务），
//      所以关着的安装既不拉起 helper 也不开端口。
//   2. loopback 端口 + 扩展令牌的展示/复制/轮换 —— 扩展的配对信息。
//   3. 连接状态 —— 复用 utils/externalMediaStatus.ts 的六态阶梯（判据只有一份）。

type ExternalMediaSettingsSubviewProps = {
    chrome: IntegrationSettingsChrome;
};

/** 六态阶梯 → 复用切换器同一组文案，判据与措辞都不在此处重新推导。 */
const AVAILABILITY_LABEL_KEY: Record<ExternalMediaAvailability, string> = {
    'ready': 'appleMusic.connected',
    'extension-missing': 'appleMusic.extensionMissing',
    'tab-not-found': 'appleMusic.tabNotFound',
    'player-not-ready': 'appleMusic.playerNotReady',
    'not-signed-in': 'appleMusic.notSignedIn',
    'storefront-mismatch': 'appleMusic.storefrontMismatch',
    'unavailable': 'appleMusic.unavailable',
};

const ExternalMediaSettingsSubview: React.FC<ExternalMediaSettingsSubviewProps> = ({ chrome }) => {
    const { t } = useTranslation();
    const {
        settingsCardClass,
        successBgColor,
        successTextColor,
        theme,
        toggleOffBackgroundClass,
    } = chrome;

    const status = useExternalMediaStore(state => state.status);
    const settings = useExternalMediaSettingsStore(state => state.settings);
    const busy = useExternalMediaSettingsStore(state => state.busy);
    const { loadSettings, setEnabled, regenerateToken } = useExternalMediaSettingsStore();

    const [tokenCopied, setTokenCopied] = useState(false);

    useEffect(() => {
        void loadSettings();
    }, [loadSettings]);

    const enabled = settings?.enabled === true;
    const availability = resolveExternalMediaAvailability(status ?? null);

    const handleCopyToken = async () => {
        if (!settings?.token) return;
        try {
            await navigator.clipboard.writeText(settings.token);
            setTokenCopied(true);
            window.setTimeout(() => setTokenCopied(false), 2000);
        } catch {
            setStatusMessage({ type: 'error', text: t('status.copyFailed', 'Copy failed') });
        }
    };

    // 轮换是**立即失效**（旧令牌作废、扩展断连），所以要一步确认而不是点到即换。
    const handleRegenerateToken = () => {
        if (!window.confirm(t('options.externalMediaRegenerateConfirm'))) return;
        void regenerateToken().then(() => {
            setStatusMessage({ type: 'info', text: t('options.externalMediaTokenRotated') });
        });
    };

    return (
        <div className="space-y-6">
            <SettingsAnchor anchorId="externalMedia" label={t('options.externalMediaSection')}>
                <SettingsSectionHeading icon={Cast} label={t('options.externalMediaSection')} />
                <div className={`p-4 rounded-xl border space-y-4 ${settingsCardClass}`}>
                    <div className="flex items-center justify-between gap-4">
                        <div className="space-y-1">
                            <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                                {t('options.externalMediaEnable')}
                            </div>
                            <div className="text-[10px] opacity-40 max-w-[320px]" style={{ color: 'var(--text-secondary)' }}>
                                {t('options.externalMediaEnableDesc')}
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={() => void setEnabled(!enabled)}
                            disabled={busy}
                            className={`w-12 h-6 rounded-full p-1 transition-colors shrink-0 disabled:opacity-40 ${!enabled ? toggleOffBackgroundClass : ''}`}
                            style={{ backgroundColor: enabled ? theme?.secondaryColor || 'rgba(114, 119, 134, 1)' : undefined }}
                        >
                            <div className={`w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${enabled ? 'translate-x-6' : 'translate-x-0'}`} />
                        </button>
                    </div>

                    <div className={`rounded-xl border p-3 space-y-1 ${settingsCardClass}`}>
                        <div className="text-[10px] uppercase tracking-[0.16em] opacity-40" style={{ color: 'var(--text-secondary)' }}>
                            {t('options.externalMediaStatus')}
                        </div>
                        <div
                            className="text-sm"
                            style={{
                                color: 'var(--text-primary)',
                                ...(enabled && availability === 'ready'
                                    ? { backgroundColor: successBgColor, color: successTextColor }
                                    : {}),
                            }}
                        >
                            {enabled
                                ? t(AVAILABILITY_LABEL_KEY[availability])
                                : t('options.externalMediaDisabled')}
                        </div>
                    </div>

                    <div className="text-[10px] opacity-40" style={{ color: 'var(--text-secondary)' }}>
                        {t('appleMusic.extensionHint')}
                    </div>
                </div>
            </SettingsAnchor>

            <SettingsAnchor anchorId="externalMediaToken" label={t('options.externalMediaToken')}>
                <SettingsSectionHeading icon={KeyRound} label={t('options.externalMediaToken')} />
                <div className={`p-4 rounded-xl border space-y-4 ${settingsCardClass}`}>
                    <div>
                        <div className="text-[10px] uppercase tracking-[0.16em] opacity-40 mb-2" style={{ color: 'var(--text-secondary)' }}>
                            {t('options.externalMediaPort')}
                        </div>
                        <div className="text-sm break-all" style={{ color: 'var(--text-primary)' }}>
                            {`ws://127.0.0.1:${settings?.port ?? 32110}`}
                        </div>
                    </div>
                    <div>
                        <div className="text-[10px] uppercase tracking-[0.16em] opacity-40 mb-2" style={{ color: 'var(--text-secondary)' }}>
                            {t('options.externalMediaTokenLabel')}
                        </div>
                        <div className="text-sm break-all" style={{ color: 'var(--text-primary)' }}>
                            {settings?.token ?? t('options.externalMediaTokenMissing')}
                        </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <button
                            type="button"
                            onClick={() => void handleCopyToken()}
                            disabled={!settings?.token}
                            className="px-3 py-2 bg-white/10 hover:bg-white/15 rounded-lg text-xs transition-colors disabled:opacity-40 flex items-center gap-2"
                            style={{ color: tokenCopied ? '#86efac' : 'var(--text-primary)' }}
                        >
                            {tokenCopied ? <Check size={14} /> : null}
                            {tokenCopied ? t('options.externalMediaCopied') : t('options.externalMediaCopy')}
                        </button>
                        <button
                            type="button"
                            onClick={handleRegenerateToken}
                            disabled={busy}
                            className="px-3 py-2 bg-white/10 hover:bg-white/15 rounded-lg text-xs transition-colors disabled:opacity-40"
                            style={{ color: 'var(--text-primary)' }}
                        >
                            {t('options.externalMediaRegenerate')}
                        </button>
                    </div>
                </div>
            </SettingsAnchor>
        </div>
    );
};

export default ExternalMediaSettingsSubview;
