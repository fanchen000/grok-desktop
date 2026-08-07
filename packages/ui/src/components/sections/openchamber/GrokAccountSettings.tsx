import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { invokeDesktopCommand } from '@/lib/desktopNative';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type GrokLoginState = 'idle' | 'running' | 'succeeded' | 'failed';

interface GrokLoginStatus {
  status: GrokLoginState;
  output: string;
  startedAt: number | null;
  completedAt: number | null;
  exitCode?: number | null;
}

interface GrokAccount {
  id: string;
  label: string;
  kind: 'system' | 'isolated';
  active: boolean;
  authenticated: boolean;
  authUpdatedAt: number | null;
  createdAt: number;
  lastUsedAt: number | null;
  login: GrokLoginStatus;
}

interface GrokAccountsPayload {
  currentId: string;
  accounts: GrokAccount[];
}

const EMPTY_PAYLOAD: GrokAccountsPayload = { currentId: 'default', accounts: [] };

const formatTime = (value: number | null, locale: string): string => {
  if (!Number.isFinite(value)) return '';
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value as number));
  } catch {
    return new Date(value as number).toLocaleString();
  }
};

const messageFromError = (error: unknown): string => (
  error instanceof Error && error.message ? error.message : String(error || 'Unknown error')
);

export const GrokAccountSettings: React.FC = () => {
  const { t, locale } = useI18n();
  const [payload, setPayload] = React.useState<GrokAccountsPayload>(EMPTY_PAYLOAD);
  const [loading, setLoading] = React.useState(true);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [newLabel, setNewLabel] = React.useState('');
  const [removeTarget, setRemoveTarget] = React.useState<GrokAccount | null>(null);

  const loadAccounts = React.useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const next = await invokeDesktopCommand<GrokAccountsPayload>('desktop_grok_accounts_list');
      setPayload(next);
      return next;
    } catch (error) {
      if (!quiet) toast.error(messageFromError(error));
      return null;
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  const hasRunningLogin = payload.accounts.some((account) => account.login.status === 'running');
  React.useEffect(() => {
    if (!hasRunningLogin) return;
    const timer = window.setInterval(() => {
      void loadAccounts(true);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [hasRunningLogin, loadAccounts]);

  const runForAccount = React.useCallback(async (
    id: string,
    action: () => Promise<GrokAccountsPayload | GrokLoginStatus>,
    successMessage?: string,
  ) => {
    setBusyId(id);
    try {
      const result = await action();
      if ('accounts' in result) setPayload(result);
      else await loadAccounts(true);
      if (successMessage) toast.success(successMessage);
    } catch (error) {
      toast.error(messageFromError(error));
    } finally {
      setBusyId(null);
    }
  }, [loadAccounts]);

  const handleCreate = React.useCallback(async () => {
    const label = newLabel.trim();
    if (!label) return;
    setBusyId('__create__');
    try {
      const next = await invokeDesktopCommand<GrokAccountsPayload>('desktop_grok_account_create', { label });
      setPayload(next);
      setNewLabel('');
      setCreateOpen(false);
      toast.success(t('settings.grokAccounts.toast.created'));
    } catch (error) {
      toast.error(messageFromError(error));
    } finally {
      setBusyId(null);
    }
  }, [newLabel, t]);

  const handleSwitch = React.useCallback((account: GrokAccount) => {
    void runForAccount(
      account.id,
      () => invokeDesktopCommand<GrokAccountsPayload>('desktop_grok_account_switch', { id: account.id }),
      t('settings.grokAccounts.toast.switched', { name: account.label }),
    );
  }, [runForAccount, t]);

  const handleLogin = React.useCallback((account: GrokAccount, method: 'oauth' | 'device') => {
    void runForAccount(
      account.id,
      () => invokeDesktopCommand<GrokLoginStatus>('desktop_grok_account_login', { id: account.id, method }),
    );
  }, [runForAccount]);

  const handleLogout = React.useCallback((account: GrokAccount) => {
    void runForAccount(
      account.id,
      () => invokeDesktopCommand<GrokAccountsPayload>('desktop_grok_account_logout', { id: account.id }),
      t('settings.grokAccounts.toast.loggedOut'),
    );
  }, [runForAccount, t]);

  const handleRemove = React.useCallback(async () => {
    const target = removeTarget;
    if (!target) return;
    setBusyId(target.id);
    try {
      const next = await invokeDesktopCommand<GrokAccountsPayload>('desktop_grok_account_remove', { id: target.id });
      setPayload(next);
      setRemoveTarget(null);
      toast.success(t('settings.grokAccounts.toast.removed'));
    } catch (error) {
      toast.error(messageFromError(error));
    } finally {
      setBusyId(null);
    }
  }, [removeTarget, t]);

  const copyLoginOutput = React.useCallback(async (output: string) => {
    try {
      await navigator.clipboard.writeText(output);
      toast.success(t('settings.grokAccounts.toast.copied'));
    } catch {
      toast.error(t('settings.grokAccounts.toast.copyFailed'));
    }
  }, [t]);

  return (
    <SettingsPageLayout
      title={t('settings.page.grokAccounts.title')}
      description={t('settings.grokAccounts.description')}
      showSaveStatus={false}
    >
      <SettingsSection
        title={t('settings.grokAccounts.section.title')}
        description={t('settings.grokAccounts.section.description')}
        headerAction={(
          <Button type="button" size="sm" onClick={() => setCreateOpen(true)} disabled={loading}>
            <Icon name="add-circle" className="h-4 w-4" />
            {t('settings.grokAccounts.actions.add')}
          </Button>
        )}
      >
        <div className="rounded-lg border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/5 px-4 py-3 typography-meta text-muted-foreground">
          <div className="flex items-start gap-2">
            <Icon name="information" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-warning)]" />
            <span>{t('settings.grokAccounts.switchNotice')}</span>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 py-8 typography-meta text-muted-foreground">
            <Icon name="loader-4" className="h-4 w-4 animate-spin" />
            {t('common.loading')}
          </div>
        ) : (
          <div className="space-y-3">
            {payload.accounts.map((account) => {
              const isBusy = busyId === account.id;
              const loginRunning = account.login.status === 'running';
              const authTime = formatTime(account.authUpdatedAt, locale);
              return (
                <article
                  key={account.id}
                  data-grok-account-id={account.id}
                  className={cn(
                    'rounded-xl border p-4 transition-colors',
                    account.active
                      ? 'border-primary/50 bg-primary/5'
                      : 'border-border/70 bg-[var(--surface-background)]',
                  )}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Icon name="user-3" className="h-4 w-4 text-muted-foreground" />
                        <h3 className="typography-ui-label text-foreground">{account.label}</h3>
                        {account.active ? (
                          <span className="rounded-full bg-primary/15 px-2 py-0.5 typography-micro text-primary">
                            {t('settings.grokAccounts.badge.current')}
                          </span>
                        ) : null}
                        <span className={cn(
                          'rounded-full px-2 py-0.5 typography-micro',
                          account.authenticated
                            ? 'bg-[var(--status-success)]/10 text-[var(--status-success)]'
                            : 'bg-muted text-muted-foreground',
                        )}>
                          {account.authenticated
                            ? t('settings.grokAccounts.badge.loggedIn')
                            : t('settings.grokAccounts.badge.loggedOut')}
                        </span>
                      </div>
                      <p className="typography-meta text-muted-foreground">
                        {account.kind === 'system'
                          ? t('settings.grokAccounts.kind.system')
                          : t('settings.grokAccounts.kind.isolated')}
                        {authTime ? ` · ${t('settings.grokAccounts.authUpdated', { time: authTime })}` : ''}
                      </p>
                    </div>

                    <div className="flex flex-wrap justify-end gap-2">
                      {!account.active ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() => handleSwitch(account)}
                          disabled={isBusy || loginRunning}
                        >
                          {isBusy ? <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin" /> : null}
                          {t('settings.grokAccounts.actions.switch')}
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        onClick={() => handleLogin(account, 'oauth')}
                        disabled={isBusy || loginRunning}
                      >
                        {loginRunning ? <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin" /> : null}
                        {account.authenticated
                          ? t('settings.grokAccounts.actions.relogin')
                          : t('settings.grokAccounts.actions.login')}
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() => handleLogin(account, 'device')}
                        disabled={isBusy || loginRunning}
                      >
                        {t('settings.grokAccounts.actions.deviceLogin')}
                      </Button>
                      {account.authenticated ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          onClick={() => handleLogout(account)}
                          disabled={isBusy || loginRunning}
                        >
                          {t('settings.grokAccounts.actions.logout')}
                        </Button>
                      ) : null}
                      {account.kind === 'isolated' ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          onClick={() => setRemoveTarget(account)}
                          disabled={isBusy || loginRunning}
                          className="text-[var(--status-error)] hover:text-[var(--status-error)]"
                        >
                          {t('settings.grokAccounts.actions.remove')}
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  {account.login.status !== 'idle' && account.login.output ? (
                    <div className={cn(
                      'mt-4 rounded-lg border px-3 py-2',
                      account.login.status === 'failed'
                        ? 'border-[var(--status-error)]/30 bg-[var(--status-error)]/5'
                        : 'border-border/60 bg-muted/30',
                    )}>
                      <div className="mb-1 flex items-center justify-between gap-3">
                        <span className="typography-meta font-medium text-foreground">
                          {account.login.status === 'running'
                            ? t('settings.grokAccounts.login.running')
                            : account.login.status === 'succeeded'
                              ? t('settings.grokAccounts.login.succeeded')
                              : t('settings.grokAccounts.login.failed')}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => void copyLoginOutput(account.login.output)}
                        >
                          {t('settings.grokAccounts.actions.copy')}
                        </Button>
                      </div>
                      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
                        {account.login.output}
                      </pre>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </SettingsSection>

      <Dialog open={createOpen} onOpenChange={(open) => !busyId && setCreateOpen(open)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.grokAccounts.create.title')}</DialogTitle>
            <DialogDescription>{t('settings.grokAccounts.create.description')}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={newLabel}
            onChange={(event) => setNewLabel(event.target.value)}
            placeholder={t('settings.grokAccounts.create.placeholder')}
            maxLength={60}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && newLabel.trim()) void handleCreate();
            }}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)} disabled={busyId === '__create__'}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button type="button" onClick={() => void handleCreate()} disabled={!newLabel.trim() || busyId === '__create__'}>
              {busyId === '__create__' ? <Icon name="loader-4" className="h-4 w-4 animate-spin" /> : null}
              {t('settings.grokAccounts.actions.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(removeTarget)} onOpenChange={(open) => !open && !busyId && setRemoveTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.grokAccounts.remove.title')}</DialogTitle>
            <DialogDescription>
              {t('settings.grokAccounts.remove.description', { name: removeTarget?.label ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setRemoveTarget(null)} disabled={Boolean(busyId)}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button type="button" variant="destructive" onClick={() => void handleRemove()} disabled={Boolean(busyId)}>
              {busyId ? <Icon name="loader-4" className="h-4 w-4 animate-spin" /> : null}
              {t('settings.grokAccounts.actions.remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsPageLayout>
  );
};
