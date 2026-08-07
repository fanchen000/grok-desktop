import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { invokeDesktopCommand } from '@/lib/desktopNative';
import { isDesktopShell } from '@/lib/desktop';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';

type GrokUsageSnapshot = {
  accountId: string;
  status: 'ready' | 'stale';
  source: 'grok-official-usage';
  period: 'weekly' | 'monthly' | 'unknown';
  usedPercent: number;
  remainingPercent: number;
  resetLabel: string | null;
  resetAt: number | null;
  fetchedAt: number;
};

const formatResetAt = (usage: GrokUsageSnapshot): string => {
  if (Number.isFinite(usage.resetAt) && (usage.resetAt ?? 0) > 0) {
    return new Date(usage.resetAt as number).toLocaleString(getCurrentIntlLocale(), {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  return usage.resetLabel || '';
};

export const GrokUsageCard: React.FC<{ isVisible?: boolean }> = ({ isVisible = true }) => {
  const { t } = useI18n();
  const [usage, setUsage] = React.useState<GrokUsageSnapshot | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(false);
  const requestVersionRef = React.useRef(0);
  const wasBusyRef = React.useRef(false);
  const hasBusySession = useGlobalSessionStatusStore((state) => {
    for (const entry of state.statusById.values()) {
      if (entry.status.type === 'busy' || entry.status.type === 'retry') return true;
    }
    return false;
  });

  const load = React.useCallback(async (force = false) => {
    if (!isDesktopShell() || !isVisible) return;
    const requestVersion = ++requestVersionRef.current;
    setLoading(true);
    setError(false);
    try {
      const response = await invokeDesktopCommand<GrokUsageSnapshot>('desktop_grok_usage_get', { force });
      if (requestVersion === requestVersionRef.current) setUsage(response);
    } catch {
      if (requestVersion === requestVersionRef.current) setError(true);
    } finally {
      if (requestVersion === requestVersionRef.current) setLoading(false);
    }
  }, [isVisible]);

  React.useEffect(() => {
    if (!isVisible) return undefined;
    void load(false);
    const interval = window.setInterval(() => void load(false), 30_000);
    const handleFocus = () => void load(false);
    const handleUpdated = (event: Event) => {
      const detail = (event as CustomEvent<GrokUsageSnapshot>).detail;
      if (detail && typeof detail === 'object') {
        setUsage(detail);
        setError(false);
        setLoading(false);
      }
    };
    const handleAccountChanged = () => {
      setUsage(null);
      void load(true);
    };
    window.addEventListener('focus', handleFocus);
    window.addEventListener('openchamber:grok-usage-updated', handleUpdated);
    window.addEventListener('openchamber:grok-account-changed', handleAccountChanged);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('openchamber:grok-usage-updated', handleUpdated);
      window.removeEventListener('openchamber:grok-account-changed', handleAccountChanged);
    };
  }, [isVisible, load]);

  React.useEffect(() => {
    if (wasBusyRef.current && !hasBusySession) {
      const timer = window.setTimeout(() => void load(true), 350);
      wasBusyRef.current = false;
      return () => window.clearTimeout(timer);
    }
    wasBusyRef.current = hasBusySession;
    return undefined;
  }, [hasBusySession, load]);

  if (!isDesktopShell()) return null;

  return (
    <div className="shrink-0 px-2.5 pb-1.5" data-testid="grok-usage-card">
      {usage ? (
        <div className="rounded-xl border border-border/70 bg-[var(--surface-muted)]/55 px-3 py-2.5 shadow-sm">
          <div className="flex items-center gap-2 typography-ui-label">
            <span className="font-medium tabular-nums text-foreground">
              {t('grokHistory.usageUsed', { percent: Math.round(usage.usedPercent) })}
            </span>
            <span className="text-muted-foreground">
              {t('grokHistory.usageRemaining', { percent: Math.round(usage.remainingPercent) })}
            </span>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="ml-auto h-7 w-7 px-0"
              disabled={loading}
              onClick={() => void load(true)}
              aria-label={loading ? t('grokHistory.usageRefreshing') : t('grokHistory.usageRefresh')}
              title={loading ? t('grokHistory.usageRefreshing') : t('grokHistory.usageRefresh')}
            >
              <Icon name="refresh" className={cn('size-4', loading && 'animate-spin')} />
            </Button>
          </div>
          <div
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-background"
            role="progressbar"
            aria-label={t('grokHistory.usage')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(usage.usedPercent)}
          >
            <div
              className="h-full origin-left rounded-full bg-primary"
              style={{ transform: `scaleX(${usage.usedPercent / 100})` }}
            />
          </div>
          <div className="mt-2 flex items-center gap-1.5 typography-meta text-muted-foreground">
            {usage.status === 'stale' ? (
              <Icon name="error-warning" className="size-3 text-status-warning" />
            ) : null}
            {formatResetAt(usage) ? (
              <span>{t('grokHistory.usageResetAt', { date: formatResetAt(usage) })}</span>
            ) : null}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void load(true)}
          className="flex w-full items-center gap-2 rounded-xl border border-border/70 px-3 py-2.5 text-left typography-meta text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
        >
          <Icon name={loading ? 'loader-4' : 'error-warning'} className={cn('size-4', loading && 'animate-spin')} />
          <span>{error ? t('grokHistory.usageUnavailable') : t('grokHistory.usageRefreshing')}</span>
          {!loading ? <Icon name="refresh" className="ml-auto size-4" /> : null}
        </button>
      )}
    </div>
  );
};
