'use strict';

// Picking and dropping: sorting paths into folders and media files, and
// adding files to a queue that is already uploading.
// Run with: node test/add-files-test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { inspectPaths } = require('../src/main/mediaScanner');
const { UploadQueue } = require('../src/main/uploadQueue');
const { signature } = require('../src/main/settings');

const AUTH = 'androidId=a&client_sig=b&callerSig=c&device_country=us&Email=user%40example.com'
  + '&google_play_services_version=1&lang=en&oauth2_foreground=1&sdk_version=28&service=s&Token=t';

async function sortsPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'add-files-'));
  try {
    const folder = path.join(dir, 'Trip');
    fs.mkdirSync(folder);
    const write = (name, body = 'x', mtime = 1000) => {
      const full = path.join(dir, name);
      fs.writeFileSync(full, body);
      fs.utimesSync(full, mtime, mtime);
      return full;
    };
    const newer = write('b.JPG', 'x', 2000);
    const older = write('a.mp4', 'x', 1000);
    const result = await inspectPaths([
      folder, newer, older,
      write('notes.txt'), write('empty.jpg', ''), write('.hidden.jpg'),
      path.join(dir, 'gone.jpg'), 'relative.jpg', 42,
    ]);
    assert.deepStrictEqual(result.folders, [folder]);
    assert.deepStrictEqual(result.files.map((f) => f.filename), ['a.mp4', 'b.JPG']);
    assert.strictEqual(result.files[1].path, newer);
    assert.strictEqual(result.skipped, 6);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('test 1 OK: picked and dropped paths sort into folders, media, and skipped');
}

async function cancelReachesEarlierUploads() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const client = {
    upload: (_p, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      gate.then(() => resolve({ outcome: 'uploaded', mediaKey: 'k' }));
    }),
  };
  const settings = { get: (k) => ({ concurrency: 1 })[k], loadCompleted: () => new Set(), markCompleted: () => {} };
  const queue = new UploadQueue({ credential: { authData: AUTH, email: 'u' }, settings, clientFactory: () => client });
  const found = (name) => ({ path: path.join(os.tmpdir(), name), filename: name, size: 1, mtimeMs: 1000 });
  await queue.enqueueScan([found('first.jpg')]);
  await queue.enqueueScan([found('second.jpg')]); // added while the first is uploading
  queue.cancelAll();
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  assert.deepStrictEqual(queue.items.map((i) => i.status), ['cancelled', 'cancelled']);
  console.log('test 2 OK: Cancel still stops uploads that were running when more files were added');
}

function recordingSettings(data = {}) {
  const completed = new Set();
  return {
    completed,
    get: (k) => data[k],
    loadCompleted: () => new Set(completed),
    markCompleted: (_e, sigs) => sigs.forEach((s) => completed.add(s)),
    forgetCompleted: (_e, sigs) => sigs.forEach((s) => completed.delete(s)),
  };
}

const waitIdle = async (queue) => {
  for (let i = 0; i < 500 && !queue.isIdle; i += 1) await new Promise((r) => setTimeout(r, 10));
};

async function chosenFilesAreRechecked() {
  const calls = [];
  const client = { upload: async (p, opts) => { calls.push({ p, force: opts.forceUpload }); return { outcome: 'alreadyBackedUp', mediaKey: 'k' }; } };
  const settings = recordingSettings();
  const queue = new UploadQueue({ credential: { authData: AUTH, email: 'u' }, settings, clientFactory: () => client });
  const file = { path: path.join(os.tmpdir(), 'chosen.jpg'), filename: 'chosen.jpg', size: 1, mtimeMs: 1000 };

  // A folder scan skips a file recorded as backed up...
  settings.completed.add(signature(file));
  assert.strictEqual((await queue.enqueueScan([file])).queued, 0);
  // ...but choosing it by hand checks it with Google again.
  assert.deepStrictEqual(await queue.enqueueChosen([file], { skipAlbum: true }), { queued: 1, alreadyDone: 0 });
  await waitIdle(queue);
  assert.strictEqual(calls.length, 1);

  // Choosing it again requeues the finished row instead of adding another.
  assert.deepStrictEqual(await queue.enqueueChosen([file], { skipAlbum: true }), { queued: 1, alreadyDone: 0 });
  await waitIdle(queue);
  assert.strictEqual(queue.items.length, 1);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[1].force, false);
  console.log('test 3 OK: picked and dropped files are checked again even when recorded as done');
}

async function reuploadMarksRows() {
  const calls = [];
  const client = { upload: async (p, opts) => {
    calls.push({ p: path.basename(p), force: opts.forceUpload });
    return opts.forceUpload
      ? { outcome: 'uploaded', mediaKey: p.endsWith('same.jpg') ? 'old' : 'new', previousKey: 'old' }
      : { outcome: 'alreadyBackedUp', mediaKey: 'old' };
  } };
  const settings = recordingSettings();
  const queue = new UploadQueue({ credential: { authData: AUTH, email: 'u' }, settings, clientFactory: () => client });
  const file = (name) => ({ path: path.join(os.tmpdir(), name), filename: name, size: 1, mtimeMs: 1000 });
  await queue.enqueueScan([file('same.jpg')]); // backed up normally first
  await waitIdle(queue);
  await queue.enqueueChosen([file('same.jpg'), file('fresh.jpg')], { forceUpload: true });
  await waitIdle(queue);
  assert.deepStrictEqual(calls.map((c) => c.force), [false, true, true]);
  const row = (name) => queue.items.find((i) => i.filename === name);
  assert.strictEqual(row('same.jpg').detail, 'Re-uploaded; Google kept the copy it already had');
  assert.strictEqual(row('fresh.jpg').detail, 'Re-uploaded as a new item; the earlier copy may still use storage');
  assert.ok(queue.items.every((i) => i.forceUpload === false), 'the mark is cleared once done');
  assert.strictEqual(settings.completed.size, 2);
  console.log('test 4 OK: re-upload forces each file and reports what Google answered');
}

(async () => {
  await sortsPaths();
  await cancelReachesEarlierUploads();
  await chosenFilesAreRechecked();
  await reuploadMarksRows();
  console.log('add files tests passed');
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
