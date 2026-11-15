'use strict';

// Main process: window lifecycle, account state machine, and the IPC surface
// the renderer talks to. Mirrors PhotosBackupApp.swift's composition root.

const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, clipboard } = require('electron');
const path = require('path');
const { connectAccount } = require('./auth');
const { CredentialStore } = require('./credentialStore');
const { Settings } = require('./settings');
const { scanFolders, inspectPaths, MEDIA_EXTENSIONS } = require('./mediaScanner');
const { pairLivePhotos } = require('./livePhotos');
const { UploadQueue, clampConcurrency } = require('./uploadQueue');
const TokenExchange = require('./tokenExchange');
const { GPMCClient, GPMCError } = require('./gpmc');
const { eventLog, buildReport } = require('./diagnostics');

let mainWindow = null;
let queue = null;
const credentials = new CredentialStore();
const settings = new Settings();

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function accountState() {
  const stored = credentials.cached;
  if (!stored) return { status: 'disconnected', email: null };
  if (!queue) return { status: 'connected', email: stored.email, validated: false };
  return { status: 'connected', email: queue.email, validated: true };
}

function emitState() {
  send('account-state', accountState());
  send('settings', settings.data);
}

function pushSnapshot(snapshot) {
  send('queue-snapshot', snapshot);
}

async function validateCredential(credential) {
  const client = new GPMCClient(credential.authData);
  await client.validateReadAccess();
}

function startQueue(credential) {
  queue = new UploadQueue({ credential, settings, onSnapshot: pushSnapshot });
  emitState();
}

// Upstream 0.3.4: a manual "Back Up Now" queues the whole selection — the
// bounded batches remain an automatic-pass technique only. Quota pacing is
// handled at the request level by the queue's 429 cooldown and retry backoff.
async function runBackup({ recheck = false } = {}) {
  if (!queue) return { error: 'not-connected' };
  const folders = settings.get('folders') || [];
  if (!folders.length) return { error: 'no-folders' };
  const released = queue.releaseRetryableFailures();
  if (recheck) settings.clearCompleted(queue.email);
  send('scan-started', {});
  const found = await scanFolders(folders);
  send('scan-finished', { count: found.length });
  eventLog().record('queue', `Scanned the configured folders: ${found.length} media file${found.length === 1 ? '' : 's'} found`);
  const pending = await withLivePhotos(found.filter((file) => !settings.isCompleted(queue.email, file)));
  const { queued } = await queue.enqueueScan(pending);
  return { found: found.length, queued, released, recheck };
}

// Join Live Photo stills and videos among files about to be queued, when
// Live Photos is on. Called after already-backed-up files are dropped, so
// their metadata is never read again.
async function withLivePhotos(files) {
  if (!settings.get('livePhotos') || !files.length) return files;
  const { items, paired, unreadable } = await pairLivePhotos(files);
  if (paired) eventLog().record('livePhoto', `Paired ${paired} Live Photo${paired === 1 ? '' : 's'}`);
  if (unreadable) {
    eventLog().record('livePhoto',
      `Could not read Live Photo details in ${unreadable} file${unreadable === 1 ? '' : 's'}; they upload on their own`, 'warning');
  }
  return items;
}

// Add folders to the backup list; returns how many were new.
function addFolders(paths) {
  const current = settings.get('folders') || [];
  const merged = [...new Set([...current, ...paths])];
  settings.update({ folders: merged });
  emitState();
  return merged.length - current.length;
}

// Queue files the user picked or dropped for a one-off upload, the desktop
// take on choosing photos in the iOS app. Chosen files are checked with
// Google even when recorded as backed up. They are not folders being backed
// up, so they never go into folder albums.
async function uploadFiles(files) {
  if (!queue) return { error: 'not-connected' };
  const result = await queue.enqueueChosen(await withLivePhotos(files), { skipAlbum: true });
  eventLog().record('queue', `You chose ${files.length} file${files.length === 1 ? '' : 's'} to upload`);
  return result;
}

// Re-upload (iOS 0.3.9): the chosen files are uploaded again, even where
// Google already holds them, so they are committed under the quota-free
// device profile. Refused here as well as hidden in the window while Allow
// re-upload is off or uploads count against quota.
function reuploadRefusal() {
  if (!queue) return { error: 'not-connected' };
  if (!settings.get('allowReupload')) return { error: 'reupload-off' };
  if (settings.get('useQuota')) return { error: 'reupload-quota' };
  return null;
}

const fileCount = (n) => `${n} file${n === 1 ? '' : 's'}`;

// The warning both re-upload buttons show before anything is sent.
async function confirmReupload(title, message, what) {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Re-upload', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title,
    message,
    detail: `${what} uploaded again, including ones already in Google Photos. This takes as long and uses as much `
      + 'data as uploading them the first time. Google Photos may keep the copy it already has, so try a few '
      + 'files first and compare your storage before and after.',
  });
  return response === 0;
}

// Re-upload a Folder…: every photo and video in the folder and its subfolders.
async function reuploadFolder() {
  const refusal = reuploadRefusal();
  if (refusal) return refusal;
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a folder to upload again',
    properties: ['openDirectory'],
  });
  if (picked.canceled || !picked.filePaths.length) return { canceled: true };
  const folder = picked.filePaths[0];
  const found = await scanFolders([folder]);
  if (!found.length) return { queued: 0, alreadyDone: 0, skipped: 0 };
  if (!await confirmReupload('Upload this folder again?',
    `Upload the ${fileCount(found.length)} in “${path.basename(folder)}” again?`,
    'Every photo and video in this folder and its subfolders is')) return { canceled: true };
  eventLog().record('reupload', `You chose to re-upload a folder of ${fileCount(found.length)}`);
  return queue.enqueueChosen(await withLivePhotos(found), { forceUpload: true });
}

// Re-upload Photos…: photos and videos picked one by one. Like Upload
// Photos…, they are not a folder being backed up, so they skip folder albums.
async function reuploadFiles() {
  const refusal = reuploadRefusal();
  if (refusal) return refusal;
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose photos and videos to upload again',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Photos and videos', extensions: MEDIA_EXTENSIONS }],
  });
  if (picked.canceled || !picked.filePaths.length) return { canceled: true };
  const { files, skipped } = await inspectPaths(picked.filePaths);
  if (!files.length) return { queued: 0, alreadyDone: 0, skipped };
  if (!await confirmReupload('Upload these photos again?',
    `Upload the ${fileCount(files.length)} you picked again?`,
    'Every photo and video you picked is')) return { canceled: true };
  eventLog().record('reupload', `You chose to re-upload ${fileCount(files.length)}`);
  return { ...(await queue.enqueueChosen(await withLivePhotos(files), { forceUpload: true, skipAlbum: true })), skipped };
}

function createWindow() {
  // Match the renderer's CSS background (styles.css) so the window never
  // flashes white before the first paint — including in dark mode.
  const backgroundColor = nativeTheme.shouldUseDarkColors ? '#16181c' : '#f5f6f8';
  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    // Fixed size: sizes refer to the page content, width and height are both
    // pinned (min === max), resizing, maximizing and fullscreen are disabled.
    useContentSize: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    minWidth: 960,
    maxWidth: 960,
    minHeight: 720,
    maxHeight: 720,
    title: 'Photos Backup',
    autoHideMenuBar: true,
    show: false,
    backgroundColor,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  // Show only once the renderer has painted: no white flash on startup.
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });

  // Restore any saved account, then validate quietly in the background.
  const stored = credentials.load();
  if (stored) {
    eventLog().record('account', 'Restored the saved Google account; checking it in the background');
    startQueue(stored);
    validateCredential(stored)
      .then(() => emitState())
      .catch((error) => {
        // Do NOT clear the stored credential here: a transient 403 looks the
        // same as a revoked token at this layer, and destroying a good
        // credential forces an unnecessary re-login. Warn instead; the user
        // can disconnect explicitly.
        eventLog().record('account', `The first read-only check after launch failed: ${error.message}`, 'warning');
        send('account-warning', error instanceof GPMCError
          ? `${error.message} The saved account is kept — if it keeps failing, disconnect and connect again.`
          : 'The saved credential could not be validated; uploads will retry automatically.');
      });
  } else if (credentials.lastLoadFailure) {
    send('account-warning', credentials.lastLoadFailure.message);
  }
  emitState();
}

function registerIpc() {
  ipcMain.handle('get-state', () => ({ account: accountState(), settings: settings.data }));

  ipcMain.handle('connect-account', async () => {
    let oauthToken;
    try {
      oauthToken = await connectAccount(mainWindow);
    } catch (error) {
      eventLog().record('account', `Sign-in did not complete: ${error.message}`, 'error');
      return { error: error.message };
    }
    let result;
    try {
      result = await TokenExchange.run(oauthToken);
    } catch (error) {
      eventLog().record('account', `Sign-in failed during the token exchange: ${error.message}`, 'error');
      return { error: `Token exchange failed — ${error.message}` };
    }
    if (result.encrypted) {
      eventLog().record('account', 'Sign-in returned a device-bound token, which this app cannot use', 'error');
      return { error: 'Google issued a bound (encrypted) token. This build cannot use it; connect an account whose token is unbound.' };
    }
    const credential = {
      androidId: result.androidId,
      email: result.email,
      masterToken: result.masterToken,
      authData: result.authData,
      connectedAt: new Date().toISOString(),
    };
    let persisted = true;
    let persistError = null;
    try {
      credentials.save(credential);
    } catch (error) {
      // Usable now, just not across relaunches (same deal as the iOS app's
      // Unpersisted path when the Keychain refuses).
      persisted = false;
      persistError = error.message;
      credentials.adopt(credential);
    }
    startQueue(credential);
    try {
      await validateCredential(credential);
    } catch (error) {
      eventLog().record('account', `The first read-only check after sign-in failed: ${error.message}`, 'warning');
      emitState();
      return { warning: `Connected as ${result.email}, but validation failed: ${error.message}` };
    }
    eventLog().record('account', 'Sign-in completed and the Google token was exchanged');
    emitState();
    return persisted
      ? { email: result.email }
      : { email: result.email, warning: `Connected as ${result.email} for this session, but the credential could not be saved to disk (${persistError}). You may need to sign in again after restarting.` };
  });

  ipcMain.handle('disconnect-account', () => {
    queue?.cancelAll();
    queue = null;
    credentials.clear();
    eventLog().record('account', 'The Google account was disconnected');
    emitState();
    return { ok: true };
  });

  // Support (upstream 0.3.6): the report is redacted on the way in, so it can
  // go straight to the clipboard.
  ipcMain.handle('copy-diagnostics', () => {
    const { text, findings } = buildReport({
      version: app.getVersion(),
      queue,
      settings,
      log: eventLog(),
    });
    eventLog().record('support', 'Created a diagnostic report');
    clipboard.writeText(text);
    return { ok: true, findings };
  });

  ipcMain.handle('select-folders', async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose folders to back up',
      properties: ['openDirectory', 'multiSelections', 'createDirectory'],
    });
    if (picked.canceled || !picked.filePaths.length) return { folders: settings.get('folders') };
    addFolders(picked.filePaths);
    return { folders: settings.get('folders') };
  });

  ipcMain.handle('select-files', async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose photos and videos to upload',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Photos and videos', extensions: MEDIA_EXTENSIONS }],
    });
    if (picked.canceled || !picked.filePaths.length) return { canceled: true };
    const { files, skipped } = await inspectPaths(picked.filePaths);
    if (!files.length) return { queued: 0, alreadyDone: 0, skipped };
    return { ...(await uploadFiles(files)), skipped };
  });

  // Drag and drop: dropped folders join the backup list, dropped photos and
  // videos upload once. Paths come from the renderer, so they are checked
  // again here rather than trusted.
  ipcMain.handle('add-paths', async (_event, paths) => {
    if (!Array.isArray(paths)) return { error: 'invalid' };
    const { folders, files, skipped } = await inspectPaths(paths.slice(0, 10000));
    const result = { foldersAdded: folders.length ? addFolders(folders) : 0, queued: 0, alreadyDone: 0, skipped };
    if (files.length) Object.assign(result, await uploadFiles(files));
    return result;
  });

  ipcMain.handle('remove-folder', (_event, folder) => {
    const folders = (settings.get('folders') || []).filter((f) => f !== folder);
    settings.update({ folders });
    emitState();
    return { folders };
  });

  ipcMain.handle('update-settings', (_event, patch) => {
    const allowed = {};
    for (const key of ['storageSaver', 'useQuota', 'dateFromFilename', 'albumsFromFolders', 'allowReupload', 'livePhotos', 'autoStart']) {
      if (key in patch) allowed[key] = !!patch[key];
    }
    if ('concurrency' in patch) allowed.concurrency = clampConcurrency(patch.concurrency);
    settings.update(allowed);
    queue?.setMaxConcurrent(settings.get('concurrency'));
    emitState();
    return settings.data;
  });

  ipcMain.handle('run-backup', () => runBackup());
  ipcMain.handle('reupload-folder', () => reuploadFolder());
  ipcMain.handle('reupload-files', () => reuploadFiles());
  ipcMain.handle('recheck-backup', () => runBackup({ recheck: true }));

  ipcMain.handle('queue-pause', () => { queue?.pause(); return { ok: true }; });
  ipcMain.handle('queue-resume', () => { queue?.resume(); return { ok: true }; });
  ipcMain.handle('queue-cancel', () => { queue?.cancelAll(); return { ok: true }; });
  ipcMain.handle('queue-retry-failed', () => { queue?.retryFailed(); return { ok: true }; });

  ipcMain.handle('open-external', (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
    return { ok: true };
  });
}

// Some Windows graphics drivers leave GPU-composited windows (notably the
// Google sign-in window) painting blank. Software rendering avoids that; it
// must be called before the app is ready. The sandbox stays on — see auth.js.
app.disableHardwareAcceleration();

app.whenReady().then(() => {
  eventLog().record('app', `Photos Backup launched (version ${app.getVersion()})`);
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// A quit the app participated in is not a crash: drop the preparation markers
// so files in flight are not counted against the crash-loop guard next
// launch, and write the diagnostic log out synchronously.
app.on('will-quit', () => {
  queue?.clearPreparationMarkers();
  eventLog().flush();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
