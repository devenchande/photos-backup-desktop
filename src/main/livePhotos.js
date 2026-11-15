'use strict';

// Live Photos on disk: an iPhone export leaves the still (HEIC or JPEG) and
// its motion (MOV) as two files. They are paired the way gotohp pairs them
// (core/livephoto.go, core/livephoto_metadata.go): by the Apple content
// identifier both files carry, not by filename, and only when the video also
// has the still-image-time marker a real Live Photo video has. Only headers
// and metadata are read; nothing is decoded.

const fsp = require('fs/promises');
const path = require('path');

const APPLE_MAKER_NOTE = Buffer.from('Apple iOS\0', 'latin1');
const FIRST_PHOTO_READ = 4 * 1024 * 1024;
const MAX_PHOTO_READ = 64 * 1024 * 1024; // gotohp's maxMakerNoteScanSize
const MAX_IDENTIFIER = 256;
const MAX_BOX_DEPTH = 32;
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'meta']);
const STILL_IMAGE_TIME = Buffer.from('com.apple.quicktime.still-image-time', 'latin1');

const PHOTO_EXTENSIONS = new Set(['.heic', '.heif', '.jpg', '.jpeg']);
const isPhotoCandidate = (file) => PHOTO_EXTENSIONS.has(path.extname(file).toLowerCase());
const isVideoCandidate = (file) => path.extname(file).toLowerCase() === '.mov';

const isCanonicalUUID = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

// ---- Photo: Apple Maker Note tag 17 ----

function parseMakerNoteIdentifier(data) {
  if (data.length < 16 || !data.subarray(0, APPLE_MAKER_NOTE.length).equals(APPLE_MAKER_NOTE)) {
    throw new Error('invalid Apple Maker Note header');
  }
  const order = data.toString('latin1', 12, 14);
  if (order !== 'MM' && order !== 'II') throw new Error('invalid Apple Maker Note byte order');
  const big = order === 'MM';
  const u16 = (at) => (big ? data.readUInt16BE(at) : data.readUInt16LE(at));
  const u32 = (at) => (big ? data.readUInt32BE(at) : data.readUInt32LE(at));
  const count = u16(14);
  if (count <= 0 || 16 + count * 12 > data.length) throw new Error('invalid Apple Maker Note entry table');
  for (let i = 0; i < count; i += 1) {
    const entry = 16 + i * 12;
    if (u16(entry) !== 17) continue; // the content identifier shared with the MOV
    if (u16(entry + 2) !== 2) throw new Error('Apple content identifier has unexpected type');
    const length = u32(entry + 4);
    if (length === 0 || length > MAX_IDENTIFIER) throw new Error('Apple content identifier has invalid length');
    let value;
    if (length <= 4) {
      value = data.subarray(entry + 8, entry + 8 + length);
    } else {
      const offset = u32(entry + 8);
      if (offset > data.length || length > data.length - offset) throw new Error('Apple content identifier points outside Maker Note');
      value = data.subarray(offset, offset + length);
    }
    const identifier = value.toString('latin1').replace(/^[\0 \t\r\n]+|[\0 \t\r\n]+$/g, '');
    if (!isCanonicalUUID(identifier)) throw new Error('Apple content identifier is not a canonical UUID');
    return identifier;
  }
  return null;
}

function findMakerNoteIdentifier(data) {
  let parseError = null;
  for (let from = 0; from < data.length;) {
    const at = data.indexOf(APPLE_MAKER_NOTE, from);
    if (at < 0) break;
    try {
      const identifier = parseMakerNoteIdentifier(data.subarray(at));
      if (identifier) return identifier;
    } catch (error) {
      parseError = error;
    }
    from = at + APPLE_MAKER_NOTE.length;
  }
  if (parseError) throw parseError;
  return null;
}

// The still's content identifier, or null when it has none. The Maker Note
// usually sits near the start, so a small read is tried before a large one.
async function readPhotoContentIdentifier(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const first = await readAt(handle, 0, Math.min(size, FIRST_PHOTO_READ));
    try {
      const identifier = findMakerNoteIdentifier(first);
      if (identifier || size <= FIRST_PHOTO_READ) return identifier;
    } catch (error) {
      if (size <= FIRST_PHOTO_READ) throw error;
    }
    return findMakerNoteIdentifier(await readAt(handle, 0, Math.min(size, MAX_PHOTO_READ)));
  } finally {
    await handle.close();
  }
}

// ---- Video: QuickTime content identifier and still-image-time track ----

async function readBox(handle, offset, parentEnd) {
  if (offset < 0 || parentEnd - offset < 8) throw new Error(`truncated QuickTime box header at ${offset}`);
  const header = await readAt(handle, offset, 8);
  if (header.length < 8) throw new Error(`truncated QuickTime box header at ${offset}`);
  let size = header.readUInt32BE(0);
  let headerSize = 8;
  if (size === 1) {
    if (parentEnd - offset < 16) throw new Error(`truncated extended QuickTime box header at ${offset}`);
    const extended = await readAt(handle, offset + 8, 8);
    size = Number(extended.readBigUInt64BE(0));
    headerSize = 16;
  } else if (size === 0) {
    size = parentEnd - offset;
  }
  if (size < headerSize || size > parentEnd - offset) throw new Error(`invalid QuickTime box size at ${offset}`);
  return { type: header.toString('latin1', 4, 8), typeCode: header.readUInt32BE(4), payloadStart: offset + headerSize, end: offset + size };
}

async function directBoxes(handle, start, end) {
  const boxes = [];
  for (let offset = start; offset < end;) {
    const box = await readBox(handle, offset, end);
    boxes.push(box);
    offset = box.end;
  }
  return boxes;
}

async function payload(handle, box, max) {
  const size = box.end - box.payloadStart;
  if (size < 0 || size > max) throw new Error(`${box.type} box payload is too large`);
  return readAt(handle, box.payloadStart, size);
}

// QuickTime allows a meta atom without the four version/flags bytes an ISO
// meta box has; the first child's size tells them apart.
async function metaChildrenStart(handle, box) {
  const size = box.end - box.payloadStart;
  if (size < 8) throw new Error('truncated QuickTime meta box');
  const header = await readAt(handle, box.payloadStart, 8);
  const firstChild = header.readUInt32BE(0);
  if (firstChild >= 8 && firstChild <= size) return box.payloadStart;
  if (size < 12) throw new Error('truncated ISO meta box');
  return box.payloadStart + 4;
}

async function walkBoxes(handle, start, end, depth, visit) {
  if (depth > MAX_BOX_DEPTH) throw new Error(`QuickTime box nesting exceeds ${MAX_BOX_DEPTH} levels`);
  for (let offset = start; offset < end;) {
    const box = await readBox(handle, offset, end);
    await visit(box);
    if (CONTAINERS.has(box.type)) {
      const childStart = box.type === 'meta' ? await metaChildrenStart(handle, box) : box.payloadStart;
      if (childStart > box.end) throw new Error(`invalid ${box.type} container`);
      await walkBoxes(handle, childStart, box.end, depth + 1, visit);
    }
    offset = box.end;
  }
}

async function quickTimeContentIdentifier(handle, meta) {
  const children = await directBoxes(handle, await metaChildrenStart(handle, meta), meta.end);
  const keysBox = children.find((box) => box.type === 'keys');
  const itemList = children.find((box) => box.type === 'ilst');
  if (!keysBox || !itemList) return null;

  const keys = await payload(handle, keysBox, 4 << 20);
  if (keys.length < 8) throw new Error('truncated QuickTime keys box');
  const count = keys.readUInt32BE(4);
  if (count > Math.floor((keys.length - 8) / 8)) throw new Error('invalid QuickTime metadata key count');
  let wanted = 0;
  for (let i = 0, offset = 8; i < count; i += 1) {
    if (keys.length - offset < 8) throw new Error('truncated QuickTime metadata key');
    const size = keys.readUInt32BE(offset);
    if (size < 8 || size > keys.length - offset) throw new Error('invalid QuickTime metadata key size');
    if (keys.toString('latin1', offset + 4, offset + 8) === 'mdta'
        && keys.toString('latin1', offset + 8, offset + size) === 'com.apple.quicktime.content.identifier') {
      wanted = i + 1;
      break;
    }
    offset += size;
  }
  if (!wanted) return null;

  for (const item of await directBoxes(handle, itemList.payloadStart, itemList.end)) {
    if (item.typeCode !== wanted) continue;
    for (const value of await directBoxes(handle, item.payloadStart, item.end)) {
      if (value.type !== 'data' || value.end - value.payloadStart < 8) continue;
      const data = await payload(handle, value, MAX_IDENTIFIER + 8);
      const identifier = data.toString('latin1', 8).replace(/^[\0 \t\r\n]+|[\0 \t\r\n]+$/g, '');
      if (!isCanonicalUUID(identifier)) throw new Error('QuickTime content identifier is not a canonical UUID');
      return identifier;
    }
  }
  return null;
}

function sampleHasStillImageTime(sample) {
  // A timed metadata sample may hold several length-prefixed values.
  for (let offset = 0; offset < sample.length;) {
    if (sample.length - offset < 8) throw new Error('truncated timed metadata value');
    const size = sample.readUInt32BE(offset);
    if (size < 9 || size > sample.length - offset) throw new Error('invalid timed metadata value size');
    if (sample.readUInt32BE(offset + 4) === 1 && sample[offset + 8] === 0xff) return true;
    offset += size;
  }
  return false;
}

async function stillImageTimeTrack(handle, sampleTable) {
  const children = await directBoxes(handle, sampleTable.payloadStart, sampleTable.end);
  const description = children.find((box) => box.type === 'stsd');
  const sizes = children.find((box) => box.type === 'stsz');
  const offsets = children.find((box) => box.type === 'stco' || box.type === 'co64');
  if (!description || !sizes || !offsets) return false;

  const stsd = await payload(handle, description, 4 << 20);
  if (stsd.length < 8) throw new Error('truncated sample description');
  let timed = false;
  for (let i = 0, offset = 8, count = stsd.readUInt32BE(4); i < count; i += 1) {
    if (stsd.length - offset < 8) throw new Error('truncated sample description entry');
    const size = stsd.readUInt32BE(offset);
    if (size < 8 || size > stsd.length - offset) throw new Error('invalid sample description entry size');
    if (stsd.toString('latin1', offset + 4, offset + 8) === 'mebx'
        && stsd.subarray(offset + 8, offset + size).includes(STILL_IMAGE_TIME)) { timed = true; break; }
    offset += size;
  }
  if (!timed) return false;

  const stsz = await payload(handle, sizes, 1 << 20);
  if (stsz.length < 12) throw new Error('truncated sample size box');
  if (stsz.readUInt32BE(8) === 0) throw new Error('still-image-time track has no samples');
  let sampleSize = stsz.readUInt32BE(4);
  if (!sampleSize) {
    if (stsz.length < 16) throw new Error('truncated variable sample size box');
    sampleSize = stsz.readUInt32BE(12);
  }
  const chunks = await payload(handle, offsets, 1 << 20);
  if (chunks.length < 12 || chunks.readUInt32BE(4) === 0) throw new Error('still-image-time track has no chunks');
  let sampleOffset;
  if (offsets.type === 'co64') {
    if (chunks.length < 16) throw new Error('truncated 64-bit chunk offset box');
    sampleOffset = Number(chunks.readBigUInt64BE(8));
  } else {
    sampleOffset = chunks.readUInt32BE(8);
  }
  if (sampleSize < 9 || sampleSize > 1 << 20) return false;
  return sampleHasStillImageTime(await readAt(handle, sampleOffset, sampleSize));
}

// { contentIdentifier, hasStillImageTime } for a MOV; the identifier is null
// when the video has none.
async function readVideoLivePhotoMetadata(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size < 8) throw new Error('invalid QuickTime file size');
    const metadata = { contentIdentifier: null, hasStillImageTime: false };
    await walkBoxes(handle, 0, size, 0, async (box) => {
      if (box.type === 'meta') {
        const identifier = await quickTimeContentIdentifier(handle, box);
        if (identifier) metadata.contentIdentifier = identifier;
      } else if (box.type === 'stbl') {
        metadata.hasStillImageTime = metadata.hasStillImageTime || await stillImageTimeTrack(handle, box);
      }
    });
    return metadata;
  } finally {
    await handle.close();
  }
}

// ---- Pairing ----

// Join each Live Photo's still and video into one item carrying the video as
// `motion`; everything else passes through unchanged, in the same order. A
// still is read only when its folder holds a Live Photo video, so ordinary
// folders cost nothing. An identifier shared by more than one still or video
// is ambiguous and left unpaired, as is a file whose metadata can't be read.
async function pairLivePhotos(found, { readPhoto = readPhotoContentIdentifier, readVideo = readVideoLivePhotoMetadata } = {}) {
  const byIdentifier = new Map();
  const slot = (id) => {
    if (!byIdentifier.has(id)) byIdentifier.set(id, { photos: [], videos: [] });
    return byIdentifier.get(id);
  };
  const liveFolders = new Set();
  let unreadable = 0;

  for (const item of found) {
    if (!isVideoCandidate(item.path)) continue;
    try {
      const metadata = await readVideo(item.path);
      if (metadata.contentIdentifier && metadata.hasStillImageTime) {
        slot(metadata.contentIdentifier.toLowerCase()).videos.push(item);
        liveFolders.add(path.dirname(item.path));
      }
    } catch { unreadable += 1; }
  }
  if (!liveFolders.size) return { items: found, paired: 0, unreadable };

  for (const item of found) {
    if (!isPhotoCandidate(item.path) || !liveFolders.has(path.dirname(item.path))) continue;
    try {
      const identifier = await readPhoto(item.path);
      if (identifier) slot(identifier.toLowerCase()).photos.push(item);
    } catch { unreadable += 1; }
  }

  const motionFor = new Map(); // still -> video
  const consumed = new Set();
  for (const { photos, videos } of byIdentifier.values()) {
    if (photos.length !== 1 || videos.length !== 1) continue;
    motionFor.set(photos[0], videos[0]);
    consumed.add(videos[0]);
  }
  const items = [];
  for (const item of found) {
    if (consumed.has(item)) continue;
    const video = motionFor.get(item);
    items.push(video
      ? { ...item, motion: { path: video.path, filename: video.filename, size: video.size, mtimeMs: video.mtimeMs } }
      : item);
  }
  return { items, paired: motionFor.size, unreadable };
}

module.exports = {
  pairLivePhotos,
  readPhotoContentIdentifier,
  readVideoLivePhotoMetadata,
  parseMakerNoteIdentifier,
};
