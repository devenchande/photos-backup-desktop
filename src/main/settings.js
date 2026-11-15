'use strict';

// App settings + per-account upload memory, persisted as JSON under userData.
// `completed` mirrors the iOS app's account-scoped record of assets already
// backed up, keyed by path+size+mtime so moved-but-unchanged files still skip.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { CompletedLedger, accountSlug } = require('./completedLedger');

const DEFAULT_SETTINGS = {
  folders: [],
  // Mirrors the iOS app's two independent toggles (Settings → Backup).
  // Defaults match upstream UploadOptions: neither counts against quota nor
  // asks for Storage Saver — uploads go up as Pixel XL originals.
  storageSaver: false,
  useQuota: false,
  // Simultaneous uploads, 1–10 (upstream 0.3.2).
  concurrency: 2,
  autoStart: true,
  // File each upload into an album named after its parent folder (the
  // gotohp AUTO album mode, applied per file).
  albumsFromFolders: true,
  // Date uploads from their filename (IMG_20240709_182027.jpg) before falling
  // back to the modification time. Google still prefers a date embedded in
  // the file; this only decides the date for files without one.
  dateFromFilename: true,
  // Shows Re-upload a Folder…, which uploads files again even where Google
  // already holds them, so they are committed under this app's quota-free
  // device profile (iOS 0.3.9 Allow Re-upload). Off until asked for: it costs
  // as much as the first backup, and Google may keep the copy it has.
  allowReupload: false,
  // Upload an iPhone Live Photo's still and video as one Live Photo: the
  // video is attached to the still as its motion, as the iOS app does by
  // default (0.3.9). Off, the video uploads as a separate video.
  livePhotos: true,
};

function migrate(data) {
  // Pre-0.2 single "quality" dropdown → upstream's two toggles.
  if ('quality' in data) {
    if (data.quality === 'saver') data.storageSaver = true;
    delete data.quality;
  }
  return data;
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

// Album names -> album media keys this app created for the account. Google's
// private API offers no album lookup, so this record is how an existing
// album is found again.
function albumsPath(email) {
  return path.join(app.getPath('userData'), `albums-${accountSlug(email)}.json`);
}

function signature(item) {
  return `${item.path}|${item.size}|${Math.floor(item.mtimeMs / 1000)}`;
}

class Settings {
  constructor() {
    try {
      this.data = { ...DEFAULT_SETTINGS, ...migrate(JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))) };
    } catch {
      this.data = { ...DEFAULT_SETTINGS };
    }
    this.completed = new CompletedLedger(app.getPath('userData'));
  }

  get(key) { return this.data[key]; }

  update(patch) {
    this.data = { ...this.data, ...patch };
    fs.writeFileSync(settingsPath(), JSON.stringify(this.data, null, 2));
    return this.data;
  }

  loadCompleted(email) { return this.completed.load(email); }

  completedCount(email) { return this.completed.size(email); }

  markCompleted(email, signatures) { this.completed.add(email, signatures); }

  // Files chosen again by hand are checked with Google again (upstream iOS
  // 3cfc6ca), so their record is dropped first.
  forgetCompleted(email, signatures) { this.completed.remove(email, signatures); }

  isCompleted(email, item) {
    return this.completed.has(email, signature(item));
  }

  // Upstream "Verify Backup": forget the account's completed record so a
  // re-check re-queues everything. The Google-side hash lookup settles what is
  // really in the cloud, so this only costs one hash + one RPC per file.
  clearCompleted(email) { this.completed.clear(email); }

  loadAlbums(email) {
    try {
      return new Map(Object.entries(JSON.parse(fs.readFileSync(albumsPath(email), 'utf8')).albums || {}));
    } catch {
      return new Map();
    }
  }

  albumKey(email, name) {
    return this.loadAlbums(email).get(name) || null;
  }

  // Pass a null key to forget an album (deleted in Google Photos, say).
  saveAlbum(email, name, key) {
    if (!email) return;
    const albums = this.loadAlbums(email);
    if (key) albums.set(name, key); else albums.delete(name);
    fs.writeFileSync(albumsPath(email), JSON.stringify({ albums: Object.fromEntries(albums) }, null, 2));
  }
}

module.exports = { Settings, signature };
