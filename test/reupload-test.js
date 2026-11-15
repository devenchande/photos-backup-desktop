'use strict';

// Re-upload through the real client: the duplicate check still runs, the
// file is sent anyway, and the result carries the key Google already had.
// Run with: node test/reupload-test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GPMCClient } = require('../src/main/gpmc');
const { bytesField, stringField } = require('../src/main/proto');

const AUTH = 'androidId=a&client_sig=b&callerSig=c&device_country=us&Email=user%40example.com'
  + '&google_play_services_version=1&lang=en&oauth2_foreground=1&sdk_version=28&service=s&Token=t';

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reupload-'));
  const file = path.join(dir, 'photo.jpg');
  fs.writeFileSync(file, 'not really a jpeg');

  let sent = 0;
  let commitKey = 'existing-key';
  const realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const reply = (body = Buffer.alloc(0), headers = {}) => new Response(body, { status: 200, headers });
    if (url.includes('android.googleapis.com/auth')) return reply('Auth=tok\nExpiry=4070880000\n');
    // Google already holds the file: media key at [1, 2, 2, 1].
    if (url.endsWith(GPMCClient.HASH_CHECK_METHOD)) return reply(bytesField(1, bytesField(2, bytesField(2, stringField(1, 'existing-key')))));
    if (url.includes('upload_id=')) {
      sent += 1;
      for await (const _chunk of init.body) { /* drain the streamed file */ }
      return reply(bytesField(2, Buffer.from('token')));
    }
    if (url.startsWith(GPMCClient.UPLOAD_ENDPOINT)) return reply(Buffer.alloc(0), { 'x-guploader-uploadid': 'up-1' });
    if (url.endsWith(GPMCClient.COMMIT_METHOD)) return reply(bytesField(1, bytesField(3, stringField(1, commitKey))));
    throw new Error(`unexpected request ${url}`);
  };

  try {
    const client = new GPMCClient(AUTH);
    const phases = [];
    const strip = ({ hash, ...rest }) => { assert.strictEqual(hash.length, 20, 'the SHA-1 comes back'); return rest; };
    const normal = strip(await client.upload(file, { onPhase: (p) => phases.push(p.phase) }));
    assert.deepStrictEqual(normal, { outcome: 'alreadyBackedUp', mediaKey: 'existing-key' });
    assert.strictEqual(sent, 0, 'a normal backup sends nothing Google already has');

    phases.length = 0;
    const same = strip(await client.upload(file, { forceUpload: true, onPhase: (p) => phases.push(p.phase) }));
    assert.deepStrictEqual(same, { outcome: 'uploaded', mediaKey: 'existing-key', previousKey: 'existing-key' });
    assert.strictEqual(sent, 1, 'a re-upload sends the file anyway');
    assert.ok(phases.includes('checkingDuplicate') && phases.includes('sending') && phases.includes('finalizing'));

    commitKey = 'new-key';
    const fresh = strip(await client.upload(file, { forceUpload: true }));
    assert.deepStrictEqual(fresh, { outcome: 'uploaded', mediaKey: 'new-key', previousKey: 'existing-key' });
  } finally {
    global.fetch = realFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('test 1 OK: a forced upload still checks, sends anyway, and reports the earlier key');
  console.log('reupload tests passed');
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
