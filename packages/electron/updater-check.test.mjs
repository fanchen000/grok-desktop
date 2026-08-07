import assert from 'node:assert/strict';
import test from 'node:test';

import { checkForDesktopUpdate, shouldSkipDesktopUpdateCheck } from './updater-check.mjs';

const compareVersions = (left, right) => left.localeCompare(right, undefined, { numeric: true });

test('signals failed checks without replacing an existing pending update', async () => {
  const pendingUpdate = { version: '2.0.0', electronUpdate: { id: 'existing' } };
  await assert.rejects(
    checkForDesktopUpdate({
      autoUpdater: { checkForUpdates: async () => { throw new Error('feed unavailable'); } },
      currentVersion: '1.0.0',
      pendingUpdate,
      compareVersions,
    }),
    /Unable to check for updates: feed unavailable.*network connection/,
  );
  assert.deepEqual(pendingUpdate, { version: '2.0.0', electronUpdate: { id: 'existing' } });
});

test('treats missing update feed (404) as no update available', async () => {
  const result = await checkForDesktopUpdate({
    autoUpdater: {
      checkForUpdates: async () => {
        throw new Error('HttpError: 404 Not Found "https://github.com/.../latest-linux.yml"');
      },
    },
    currentVersion: '1.15.0',
    pendingUpdate: { version: '1.16.0' },
    compareVersions,
  });
  assert.equal(result.available, false);
  assert.equal(result.pendingUpdate, null);
  assert.equal(result.nextVersion, '1.15.0');
});

test('treats a missing packaged app-update.yml as no update in unpacked directory builds', async () => {
  const result = await checkForDesktopUpdate({
    autoUpdater: {
      checkForUpdates: async () => {
        throw new Error("ENOENT: no such file or directory, open 'D:\\GrokCodeApp\\resources\\app-update.yml'");
      },
    },
    currentVersion: '1.18.1',
    pendingUpdate: null,
    compareVersions,
  });
  assert.equal(result.available, false);
  assert.equal(result.pendingUpdate, null);
  assert.equal(result.nextVersion, '1.18.1');
});

test('skips electron-updater entirely when an unpacked Windows build has no app-update.yml', () => {
  assert.equal(shouldSkipDesktopUpdateCheck({
    platform: 'win32',
    updateConfigPath: 'D:\\GrokCodeApp\\resources\\app-update.yml',
    existsSync: () => false,
  }), true);
  assert.equal(shouldSkipDesktopUpdateCheck({
    platform: 'win32',
    updateConfigPath: 'D:\\GrokCodeApp\\resources\\app-update.yml',
    existsSync: () => true,
  }), false);
  assert.equal(shouldSkipDesktopUpdateCheck({
    platform: 'darwin',
    updateConfigPath: '/Applications/Grok Code.app/Contents/Resources/app-update.yml',
    existsSync: () => false,
  }), false);
});

test('authoritative no-update result clears pending update', async () => {
  const result = await checkForDesktopUpdate({
    autoUpdater: { checkForUpdates: async () => ({ updateInfo: { version: '1.0.0' } }) },
    currentVersion: '1.0.0',
    pendingUpdate: { version: '2.0.0' },
    compareVersions,
  });
  assert.equal(result.available, false);
  assert.equal(result.pendingUpdate, null);
});
