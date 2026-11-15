'use strict';

// Live Photos: reading the Apple content identifier from a still and a MOV,
// pairing them, the motion's requests, and the queue's motion step.
// Run with: node test/live-photos-test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pairLivePhotos, readPhotoContentIdentifier, readVideoLivePhotoMetadata } = require('../src/main/livePhotos');
const { GPMCClient, GPMCError } = require('../src/main/gpmc');
const { UploadQueue } = require('../src/main/uploadQueue');
const { signature } = require('../src/main/settings');
const { bytesField, stringField, fields, numberAt } = require('../src/main/proto');

const AUTH = 'androidId=a&client_sig=b&callerSig=c&device_country=us&Email=user%40example.com'
  + '&google_play_services_version=1&lang=en&oauth2_foreground=1&sdk_version=28&service=s&Token=t';
const ID_A = '1E2D3C4B-5A69-4788-96A5-B4C3D2E1F001';
const ID_B = '1E2D3C4B-5A69-4788-96A5-B4C3D2E1F002';

// ---- Synthetic files with an iPhone's metadata layout ----

const u16 = (n, big = true) => { const b = Buffer.alloc(2); big ? b.writeUInt16BE(n) : b.writeUInt16LE(n); return b; };
const u32 = (n, big = true) => { const b = Buffer.alloc(4); big ? b.writeUInt32BE(n) : b.writeUInt32LE(n); return b; };

// A still: some leading bytes, then an Apple Maker Note whose tag 17 holds the
// identifier (as an offset into the note, since it is longer than 4 bytes).
function still(identifier, { big = true, padding = 500 } = {}) {
  const value = Buffer.from(`${identifier}\0`, 'latin1');
  const entries = 2;
  const valueOffset = 16 + entries * 12;
  const note = Buffer.concat([
    Buffer.from('Apple iOS\0', 'latin1'), Buffer.from([0, 1]), Buffer.from(big ? 'MM' : 'II', 'latin1'), u16(entries, big),
    u16(1, big), u16(9, big), u32(1, big), u32(14, big),                       // an unrelated tag
    u16(17, big), u16(2, big), u32(value.length, big), u32(valueOffset, big),  // the content identifier
    value,
  ]);
  return Buffer.concat([Buffer.from('ftypheic'), Buffer.alloc(padding, 7), note, Buffer.alloc(200, 9)]);
}

const box = (type, ...children) => {
  const body = Buffer.concat(children);
  return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]);
};

// A MOV: QuickTime metadata naming the content identifier, and a timed
// metadata track whose first sample holds the still-image-time marker.
function movie(identifier, { stillImageTime = true } = {}) {
  const key = 'com.apple.quicktime.content.identifier';
  const keys = box('keys', u32(0), u32(2),
    u32(8 + 'com.apple.quicktime.make'.length), Buffer.from('mdta'), Buffer.from('com.apple.quicktime.make'),
    u32(8 + key.length), Buffer.from('mdta'), Buffer.from(key));
  const item = (index, value) => Buffer.concat([
    u32(8 + 16 + value.length), u32(index), box('data', u32(1), u32(0), Buffer.from(value, 'latin1')),
  ]);
  const ilst = box('ilst', item(1, 'Apple'), identifier ? item(2, identifier) : Buffer.alloc(0));
  const meta = box('meta', box('hdlr', Buffer.alloc(24)), keys, ilst); // QuickTime form: no version bytes
  const sample = Buffer.concat([u32(9), u32(1), Buffer.from([0xff])]);
  const track = (offset) => box('trak', box('mdia', box('minf', box('stbl',
    box('stsd', u32(0), u32(1), box('mebx', Buffer.alloc(8), Buffer.from(stillImageTime
      ? 'keys..com.apple.quicktime.still-image-time' : 'keys..com.apple.quicktime.other'))),
    box('stsz', u32(0), u32(0), u32(1), u32(sample.length)),
    box('stco', u32(0), u32(1), u32(offset))))));
  const ftyp = box('ftyp', Buffer.from('qt  '), u32(0));
  const moovLength = box('moov', meta, track(0)).length;
  const sampleOffset = ftyp.length + moovLength + 8;
  return Buffer.concat([ftyp, box('moov', meta, track(sampleOffset)), box('mdat', sample)]);
}

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
  return Promise.resolve(fn(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

function write(dir, relative, bytes, mtime = 1700000000) {
  const full = path.join(dir, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, bytes);
  fs.utimesSync(full, mtime, mtime);
  const stat = fs.statSync(full);
  return { path: full, filename: path.basename(full), size: stat.size, mtimeMs: stat.mtimeMs };
}

async function readers() {
  await withDir(async (dir) => {
    assert.strictEqual(await readPhotoContentIdentifier(write(dir, 'big.heic', still(ID_A)).path), ID_A);
    assert.strictEqual(await readPhotoContentIdentifier(write(dir, 'little.jpg', still(ID_A, { big: false })).path), ID_A);
    assert.strictEqual(await readPhotoContentIdentifier(write(dir, 'plain.jpg', Buffer.alloc(3000, 1)).path), null);
    // Past the first 4 MB read, the larger read still finds it.
    assert.strictEqual(await readPhotoContentIdentifier(write(dir, 'deep.heic', still(ID_B, { padding: 5 * 1024 * 1024 })).path), ID_B);

    assert.deepStrictEqual(await readVideoLivePhotoMetadata(write(dir, 'live.mov', movie(ID_A)).path),
      { contentIdentifier: ID_A, hasStillImageTime: true });
    assert.deepStrictEqual(await readVideoLivePhotoMetadata(write(dir, 'untimed.mov', movie(ID_A, { stillImageTime: false })).path),
      { contentIdentifier: ID_A, hasStillImageTime: false });
    assert.deepStrictEqual(await readVideoLivePhotoMetadata(write(dir, 'clip.mov', movie(null)).path),
      { contentIdentifier: null, hasStillImageTime: true });
    await assert.rejects(readVideoLivePhotoMetadata(write(dir, 'broken.mov', Buffer.concat([u32(4000), Buffer.from('moov')])).path));
  });
  console.log('test 1 OK: the content identifier is read from stills and MOVs');
}

async function pairing() {
  await withDir(async (dir) => {
    const files = [
      write(dir, 'Trip/IMG_0001.HEIC', still(ID_A)),
      write(dir, 'Trip/IMG_0001.MOV', movie(ID_A)),
      write(dir, 'Trip/renamed.MOV', movie(ID_B)),       // pairs by identifier, not by name
      write(dir, 'Trip/IMG_0002.HEIC', still(ID_B)),
      write(dir, 'Trip/IMG_0003.JPG', still('1E2D3C4B-5A69-4788-96A5-B4C3D2E1F009')), // no video
      write(dir, 'Trip/clip.MOV', movie(null)),           // an ordinary video
      write(dir, 'Home/photo.jpg', still(ID_A)),          // a folder with no Live Photo video
    ];
    const read = [];
    const { items, paired } = await pairLivePhotos(files, {
      readPhoto: async (file) => { read.push(path.basename(file)); return readPhotoContentIdentifier(file); },
    });
    assert.strictEqual(paired, 2);
    assert.ok(!read.includes('photo.jpg'), 'stills in folders without Live Photo videos are not read');
    const byName = Object.fromEntries(items.map((i) => [i.filename, i]));
    assert.strictEqual(byName['IMG_0001.HEIC'].motion.filename, 'IMG_0001.MOV');
    assert.strictEqual(byName['IMG_0002.HEIC'].motion.filename, 'renamed.MOV');
    assert.ok(!byName['IMG_0001.MOV'] && !byName['renamed.MOV'], 'paired videos are folded into their stills');
    assert.ok(byName['IMG_0003.JPG'] && !byName['IMG_0003.JPG'].motion);
    assert.ok(byName['clip.MOV'] && byName['photo.jpg']);
    assert.deepStrictEqual(items.map((i) => i.filename),
      ['IMG_0001.HEIC', 'IMG_0002.HEIC', 'IMG_0003.JPG', 'clip.MOV', 'photo.jpg'], 'order kept');

    // An identifier claimed twice is ambiguous: nothing pairs.
    const twice = [files[0], files[1], write(dir, 'Trip/copy.HEIC', still(ID_A))];
    const ambiguous = await pairLivePhotos(twice);
    assert.strictEqual(ambiguous.paired, 0);
    assert.strictEqual(ambiguous.items.length, 3);
  });
  console.log('test 2 OK: stills and videos pair by identifier; ambiguous and lone files stay single');
}

async function motionRequests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-'));
  const file = path.join(dir, 'IMG_0001.MOV');
  fs.writeFileSync(file, 'not really a movie');
  const stillHash = Buffer.alloc(20, 0xab);
  const lookups = [];
  let commit = null;
  let answers = { motion: null, standalone: null };
  const realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const reply = (body = Buffer.alloc(0), headers = {}) => new Response(body, { status: 200, headers });
    if (url.includes('android.googleapis.com/auth')) return reply('Auth=tok\nExpiry=4070880000\n');
    if (url.endsWith(GPMCClient.HASH_CHECK_METHOD)) {
      // Request field 1 -> query (field 1); sha1MediaType 2 marks a motion lookup.
      const query = fields(fields(Buffer.from(init.body))[1][0])[1][0];
      const motion = numberAt(5, query) === 2n;
      lookups.push(motion ? 'motion' : 'standalone');
      const key = motion ? answers.motion : answers.standalone;
      return reply(key ? bytesField(1, bytesField(2, bytesField(2, stringField(1, key)))) : Buffer.alloc(0));
    }
    if (url.includes('upload_id=')) {
      for await (const _chunk of init.body) { /* drain */ }
      return reply(bytesField(2, Buffer.from('token')));
    }
    if (url.startsWith(GPMCClient.UPLOAD_ENDPOINT)) return reply(Buffer.alloc(0), { 'x-guploader-uploadid': 'up-1' });
    if (url.endsWith(GPMCClient.COMMIT_METHOD)) {
      commit = Buffer.from(init.body);
      return reply(bytesField(1, bytesField(3, stringField(1, 'still-key'))));
    }
    throw new Error(`unexpected request ${url}`);
  };
  try {
    const client = new GPMCClient(AUTH);
    answers = { motion: 'still-key', standalone: null };
    assert.deepStrictEqual(await client.uploadMotion(file, { stillHash }), { outcome: 'alreadyAttached', mediaKey: 'still-key' });
    assert.deepStrictEqual(lookups, ['motion']);
    assert.strictEqual(commit, null);

    lookups.length = 0;
    answers = { motion: null, standalone: 'video-key' };
    assert.deepStrictEqual(await client.uploadMotion(file, { stillHash }), { outcome: 'standalone', mediaKey: 'video-key' });
    assert.deepStrictEqual(lookups, ['motion', 'standalone']);
    assert.strictEqual(commit, null, 'a video already in the library is not committed again');

    answers = { motion: null, standalone: null };
    assert.deepStrictEqual(await client.uploadMotion(file, { stillHash, filename: 'IMG_0001.MOV', modified: new Date(1700000000000) }),
      { outcome: 'attached', mediaKey: 'still-key' });
    const blueprint = fields(commit)[1][0];
    assert.strictEqual(fields(blueprint)[2][0].toString(), 'IMG_0001.MOV');
    const reconcile = fields(blueprint)[9][0];
    assert.strictEqual(numberAt(2, reconcile), 1n, 'reconcileType Phodeo');
    assert.ok(fields(reconcile)[3][0].equals(stillHash), "points at the still's SHA-1");
    assert.strictEqual(numberAt(1, fields(blueprint)[4][0]), 1700000000n);
  } finally {
    global.fetch = realFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('test 3 OK: the motion is looked up as a Live Photo motion and committed onto its still');
}

async function queueStep() {
  const settingsWith = () => {
    const completed = new Set();
    return { completed, get: () => undefined, loadCompleted: () => new Set(completed), markCompleted: (_e, s) => s.forEach((x) => completed.add(x)) };
  };
  const waitIdle = async (queue) => { for (let i = 0; i < 500 && !queue.isIdle; i += 1) await new Promise((r) => setTimeout(r, 10)); };
  const pair = {
    path: path.join(os.tmpdir(), 'IMG_0001.HEIC'), filename: 'IMG_0001.HEIC', size: 10, mtimeMs: 1000,
    motion: { path: path.join(os.tmpdir(), 'IMG_0001.MOV'), filename: 'IMG_0001.MOV', size: 20, mtimeMs: 1000 },
  };
  const run = async (uploadMotion, stillOutcome = 'uploaded') => {
    const calls = [];
    const client = {
      upload: async () => { calls.push('still'); return { outcome: stillOutcome, mediaKey: 'still-key', hash: Buffer.alloc(20, 1) }; },
      uploadMotion: async (p, opts) => { calls.push('motion'); return uploadMotion(p, opts); },
    };
    const settings = settingsWith();
    const queue = new UploadQueue({ credential: { authData: AUTH, email: 'u' }, settings, clientFactory: () => client });
    await queue.enqueueScan([pair]);
    await waitIdle(queue);
    return { row: queue.items[0], calls, settings };
  };

  let seenHash = null;
  const done = await run(async (_p, opts) => { seenHash = opts.stillHash; return { outcome: 'attached', mediaKey: 'still-key' }; }, 'alreadyBackedUp');
  assert.deepStrictEqual(done.calls, ['still', 'motion']);
  assert.ok(seenHash.equals(Buffer.alloc(20, 1)), "the motion gets the still's hash");
  assert.strictEqual(done.row.status, 'uploaded', 'a found still whose motion went up counts as uploaded');
  assert.strictEqual(done.row.detail, 'Live Photo motion attached');
  assert.deepStrictEqual([...done.settings.completed].sort(), [signature(pair), signature(pair.motion)].sort());

  const refused = await run(async () => { throw new GPMCError('server', 'Google returned HTTP 400 during finalization.'); });
  assert.strictEqual(refused.row.status, 'uploaded', 'the photo is backed up even when the motion is refused');
  assert.match(refused.row.detail, /motion was refused/);

  let tries = 0;
  const flaky = await run(async () => {
    tries += 1;
    if (tries === 1) throw new GPMCError('transport', 'Could not reach Google: reset');
    return { outcome: 'attached', mediaKey: 'still-key' };
  });
  assert.deepStrictEqual(flaky.calls, ['still', 'motion', 'still', 'motion'], 'a transient failure retries the row');
  assert.strictEqual(flaky.row.status, 'uploaded');
  console.log('test 4 OK: the queue attaches the motion after the still and handles its failures');
}

(async () => {
  await readers();
  await pairing();
  await motionRequests();
  await queueStep();
  console.log('live photo tests passed');
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
