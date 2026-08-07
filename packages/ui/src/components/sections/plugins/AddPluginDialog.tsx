import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Radio } from '@/components/ui/radio';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { SortableTabsStrip, type SortableTabsStripItem } from '@/components/ui/sortable-tabs-strip';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import {
  usePluginsStore,
  type GrokMarketplacePlugin,
  type PluginScope,
} from '@/stores/usePluginsStore';

type TabKey = 'marketplace' | 'npm' | 'path' | 'file';

interface AddPluginDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultScope?: PluginScope;
}

const FILENAME_PATTERN = /^[a-z0-9][a-z0-9-_.]*\.(js|ts|mjs|cjs)$/;

function parseOptions(raw: string): { ok: true; value?: Record<string, unknown> } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: undefined };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

export const AddPluginDialog: React.FC<AddPluginDialogProps> = ({
  open,
  onOpenChange,
  defaultScope = 'user',
}) => {
  const { t } = useI18n();
  const createEntry = usePluginsStore((s) => s.createEntry);
  const createFile = usePluginsStore((s) => s.createFile);
  const loadGrokMarketplace = usePluginsStore((s) => s.loadGrokMarketplace);
  const installGrokMarketplacePlugin = usePluginsStore((s) => s.installGrokMarketplacePlugin);

  const [tab, setTab] = React.useState<TabKey>('npm');
  const [spec, setSpec] = React.useState('');
  const [optionsJson, setOptionsJson] = React.useState('');
  const [fileName, setFileName] = React.useState('');
  const [content, setContent] = React.useState('');
  const [scope, setScope] = React.useState<PluginScope>(defaultScope);
  const [submitting, setSubmitting] = React.useState(false);
  const [marketplaceQuery, setMarketplaceQuery] = React.useState('');
  const [marketplacePlugins, setMarketplacePlugins] = React.useState<GrokMarketplacePlugin[]>([]);
  const [marketplaceLoading, setMarketplaceLoading] = React.useState(false);
  const [installingSpec, setInstallingSpec] = React.useState<string | null>(null);

  const resetForm = React.useCallback(() => {
    setSpec('');
    setOptionsJson('');
    setFileName('');
    setContent('');
    setScope(defaultScope);
    setMarketplaceQuery('');
    setMarketplacePlugins([]);
    setMarketplaceLoading(false);
    setInstallingSpec(null);
  }, [defaultScope]);

  React.useEffect(() => {
    if (open) {
      setTab('marketplace');
      resetForm();
    }
  }, [open, resetForm]);

  const handleTabChange = (next: TabKey) => {
    if (next === tab) return;
    setTab(next);
    resetForm();
  };

  React.useEffect(() => {
    if (!open || tab !== 'marketplace') return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setMarketplaceLoading(true);
      void loadGrokMarketplace(marketplaceQuery).then((plugins) => {
        if (!cancelled) setMarketplacePlugins(plugins);
      }).finally(() => {
        if (!cancelled) setMarketplaceLoading(false);
      });
    }, marketplaceQuery.trim() ? 250 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [loadGrokMarketplace, marketplaceQuery, open, tab]);

  const handleMarketplaceInstall = React.useCallback(async (plugin: GrokMarketplacePlugin) => {
    if (installingSpec) return;
    setInstallingSpec(plugin.spec);
    try {
      const result = await installGrokMarketplacePlugin(plugin.spec);
      if (!result.ok) {
        toast.error(result.message || t('settings.plugins.marketplace.installFailed'));
        return;
      }
      toast.success(t('settings.plugins.marketplace.installed'), { description: plugin.name });
      setMarketplacePlugins((current) => current.filter((entry) => entry.spec !== plugin.spec));
    } finally {
      setInstallingSpec(null);
    }
  }, [installGrokMarketplacePlugin, installingSpec, t]);

  const optionsResult = React.useMemo(() => parseOptions(optionsJson), [optionsJson]);
  const optionsInvalid = !optionsResult.ok;
  const fileNameInvalid = tab === 'file' && fileName.trim() !== '' && !FILENAME_PATTERN.test(fileName.trim());
  const specEmpty = (tab === 'npm' || tab === 'path') && spec.trim() === '';
  const contentEmpty = tab === 'file' && content.trim() === '';
  const fileNameEmpty = tab === 'file' && fileName.trim() === '';

  const submitDisabled =
    submitting ||
    optionsInvalid ||
    (tab === 'npm' && specEmpty) ||
    (tab === 'path' && specEmpty) ||
    (tab === 'file' && (fileNameEmpty || fileNameInvalid || contentEmpty));

  const handleSubmit = async () => {
    if (submitDisabled) return;
    setSubmitting(true);
    try {
      let result;
      if (tab === 'file') {
        result = await createFile({ fileName: fileName.trim(), content, scope });
      } else {
        result = await createEntry({
          spec: spec.trim(),
          options: optionsResult.ok ? optionsResult.value : undefined,
          scope,
        });
      }
      if (result.ok) {
        toast.success(result.message || t('settings.plugins.toast.created'));
        if (result.reloadFailed) {
          toast.warning(t('settings.plugins.toast.reloadFailed'));
        }
        onOpenChange(false);
      } else {
        toast.error(result.message || t('settings.plugins.sidebar.toast.deleteFailed'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const tabs = React.useMemo<SortableTabsStripItem[]>(() => [
    { id: 'marketplace', label: t('settings.plugins.dialog.add.tab.marketplace') },
    { id: 'npm', label: t('settings.plugins.dialog.add.tab.npm') },
    { id: 'path', label: t('settings.plugins.dialog.add.tab.path') },
    { id: 'file', label: t('settings.plugins.dialog.add.tab.file') },
  ], [t]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && submitting) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('settings.plugins.dialog.add.title')}</DialogTitle>
          <DialogDescription>
            {t('settings.plugins.sidebar.empty.description')}
          </DialogDescription>
        </DialogHeader>

        <SortableTabsStrip
          items={tabs}
          activeId={tab}
          onSelect={(id) => handleTabChange(id as TabKey)}
          layoutMode="fit"
          variant="active-pill"
          activePillLowercase={false}
          className="h-10"
        />

        <div className="flex flex-col gap-4">
          {tab === 'marketplace' && (
            <div className="flex min-h-0 flex-col gap-3">
              <div className="rounded-md border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/5 px-3 py-2 typography-meta text-muted-foreground">
                {t('settings.plugins.marketplace.trustWarning')}
              </div>
              <Input
                value={marketplaceQuery}
                onChange={(event) => setMarketplaceQuery(event.target.value)}
                placeholder={t('settings.plugins.marketplace.search')}
                aria-label={t('settings.plugins.marketplace.search')}
                disabled={Boolean(installingSpec)}
              />
              <div className="max-h-[360px] min-h-[180px] overflow-y-auto rounded-md border border-border">
                {marketplaceLoading ? (
                  <div className="flex h-40 items-center justify-center gap-2 text-muted-foreground">
                    <Icon name="loader-4" className="h-4 w-4 animate-spin" />
                    <span className="typography-meta">{t('settings.plugins.marketplace.loading')}</span>
                  </div>
                ) : marketplacePlugins.length === 0 ? (
                  <div className="flex h-40 items-center justify-center px-6 text-center typography-meta text-muted-foreground">
                    {t('settings.plugins.marketplace.empty')}
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {marketplacePlugins.map((plugin) => {
                      const installing = installingSpec === plugin.spec;
                      return (
                        <div key={plugin.spec} className="flex items-start gap-3 p-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="typography-ui-label text-foreground">{plugin.name}</span>
                              <span className="rounded bg-[var(--surface-elevated)] px-1.5 py-0.5 typography-micro text-muted-foreground">
                                {plugin.marketplace}
                              </span>
                            </div>
                            {plugin.description ? (
                              <p className="mt-1 line-clamp-3 typography-meta text-muted-foreground">
                                {plugin.description}
                              </p>
                            ) : null}
                            <p className="mt-1 typography-micro text-muted-foreground">
                              {t('settings.page.skills.title')}: {plugin.counts.skills}
                              {' · '}{t('settings.page.agents.title')}: {plugin.counts.agents}
                              {' · '}MCP: {plugin.counts.mcpServers}
                            </p>
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => void handleMarketplaceInstall(plugin)}
                            disabled={Boolean(installingSpec)}
                          >
                            {installing ? <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin" /> : null}
                            {t(installing ? 'settings.plugins.marketplace.installing' : 'settings.plugins.marketplace.install')}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {(tab === 'npm' || tab === 'path') && (
            <>
              <div data-settings-item="plugins.spec" className="flex flex-col gap-1.5">
                <label htmlFor="plugin-spec" className="typography-ui-label text-foreground">
                  {t('settings.plugins.page.field.spec')}
                </label>
                <Input
                  id="plugin-spec"
                  value={spec}
                  onChange={(e) => setSpec(e.target.value)}
                  placeholder={t('settings.plugins.page.field.spec.placeholder')}
                  aria-invalid={specEmpty ? false : undefined}
                  disabled={submitting}
                />
                {specEmpty && (
                  <p className="typography-meta text-muted-foreground">
                    {t('settings.plugins.validation.specRequired')}
                  </p>
                )}
              </div>

              <div data-settings-item="plugins.options" className="flex flex-col gap-1.5">
                <label htmlFor="plugin-options" className="typography-ui-label text-foreground">
                  {t('settings.plugins.page.field.options')}
                </label>
                <Textarea
                  id="plugin-options"
                  value={optionsJson}
                  onChange={(e) => setOptionsJson(e.target.value)}
                  rows={5}
                  className="font-mono"
                  hasError={optionsInvalid}
                  disabled={submitting}
                />
                {optionsInvalid && (
                  <p className="typography-meta text-[var(--status-error)]">
                    {t('settings.plugins.page.field.options.invalidJson')}
                  </p>
                )}
              </div>
            </>
          )}

          {tab === 'file' && (
            <>
              <div data-settings-item="plugins.content" className="flex flex-col gap-1.5">
                <label htmlFor="plugin-filename" className="typography-ui-label text-foreground">
                  {t('settings.plugins.page.field.fileName')}
                </label>
                <Input
                  id="plugin-filename"
                  value={fileName}
                  onChange={(e) => setFileName(e.target.value)}
                  placeholder="my-plugin.ts"
                  aria-invalid={fileNameInvalid || undefined}
                  disabled={submitting}
                />
                {fileNameInvalid && (
                  <p className="typography-meta text-[var(--status-error)]">
                    {t('settings.plugins.validation.fileName')}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="plugin-content" className="typography-ui-label text-foreground">
                  {t('settings.plugins.page.field.content')}
                </label>
                <Textarea
                  id="plugin-content"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  rows={16}
                  className="font-mono"
                  disabled={submitting}
                />
              </div>
            </>
          )}

          {tab !== 'marketplace' && (
            <div className="flex flex-col gap-1.5">
              <span className="typography-ui-label text-foreground">
                {t('settings.plugins.page.field.scope')}
              </span>
              <div className="flex items-center gap-4">
                {(['user', 'project'] as const).map((value) => {
                  const selected = scope === value;
                  const label =
                    value === 'user'
                      ? t('settings.plugins.scope.user')
                      : t('settings.plugins.scope.project');
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setScope(value)}
                      disabled={submitting}
                      className="flex items-center gap-2 py-1 text-left disabled:opacity-50"
                    >
                      <Radio
                        checked={selected}
                        onChange={() => setScope(value)}
                        ariaLabel={label}
                      />
                      <span
                        className={cn(
                          'typography-ui-label font-normal',
                          selected ? 'text-foreground' : 'text-foreground/60',
                        )}
                      >
                        {label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting || Boolean(installingSpec)}
          >
            {t('settings.plugins.dialog.add.action.cancel')}
          </Button>
          {tab !== 'marketplace' && <Button
            size="sm"
            onClick={() => {
              void handleSubmit();
            }}
            disabled={submitDisabled}
          >
            {submitting ? (
              <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            {t('settings.plugins.dialog.add.action.submit')}
          </Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
