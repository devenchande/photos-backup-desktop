'use strict';

// The finished-files record: appends per finish, compaction on load, torn
// lines, forgetting, and reading the record older versions wrote.
// Run with: node test/completed-ledger-test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CompletedLedger } = require('../src/main/completedLedger');

const EMAIL = 'someone@example.com';

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

withDir((dir) => {
  const ledger = new CompletedLedger(dir);
  // The record an older version wrote is read as is.
  fs.writeFileSync(ledger.jsonPath(EMAIL), JSON.stringify({ signatures: ['old|1|1'] }));
  assert.deepStrictEqual([...ledger.load(EMAIL)], ['old|1|1']);

  // A finish appends a line; the JSON is not rewritten.
  const before = fs.readFileSync(ledger.jsonPath(EMAIL), 'utf8');
  ledger.add(EMAIL, ['a|1|1', 'b|2|2']);
  ledger.add(EMAIL, ['a|1|1']); // already there: nothing appended
  assert.strictEqual(fs.readFileSync(ledger.jsonPath(EMAIL), 'utf8'), before);
  assert.strictEqual(fs.readFileSync(ledger.logPath(EMAIL), 'utf8').trim().split('\n').length, 2);
  assert.ok(ledger.has(EMAIL, 'b|2|2'));
  assert.strictEqual(ledger.size(EMAIL), 3);

  // A fresh process folds the log into the JSON, skipping a torn last line,
  // and a path holding a newline survives the round trip.
  ledger.add(EMAIL, ['odd\nname|3|3']);
  fs.appendFileSync(ledger.logPath(EMAIL), '"torn');
  const reopened = new CompletedLedger(dir);
  assert.deepStrictEqual([...reopened.load(EMAIL)].sort(), ['a|1|1', 'b|2|2', 'odd\nname|3|3', 'old|1|1']);
  assert.ok(!fs.existsSync(reopened.logPath(EMAIL)), 'log folded in');
  assert.strictEqual(JSON.parse(fs.readFileSync(reopened.jsonPath(EMAIL), 'utf8')).signatures.length, 4);

  // Forgetting rewrites the record without those files.
  reopened.remove(EMAIL, ['a|1|1', 'missing|0|0']);
  assert.ok(!new CompletedLedger(dir).has(EMAIL, 'a|1|1'));

  // Clearing drops both files and the cache; accounts stay apart.
  reopened.add('other@example.com', ['x|1|1']);
  reopened.clear(EMAIL);
  assert.strictEqual(reopened.size(EMAIL), 0);
  assert.ok(!fs.existsSync(reopened.jsonPath(EMAIL)));
  assert.strictEqual(reopened.size('other@example.com'), 1);
});
console.log('test 1 OK: finishes append, load compacts, forget and clear rewrite');

withDir((dir) => {
  // The point of the change: finishes stay cheap. The old rewrite-per-finish
  // record took over two minutes for 5,000 on the same machine.
  const ledger = new CompletedLedger(dir);
  const started = Date.now();
  for (let i = 0; i < 5000; i += 1) ledger.add(EMAIL, [`C:\\Photos\\IMG_${i}.jpg|123456|1700000000`]);
  const elapsed = Date.now() - started;
  assert.strictEqual(new CompletedLedger(dir).size(EMAIL), 5000);
  assert.ok(elapsed < 15000, `5,000 finishes took ${elapsed} ms`);
  console.log(`test 2 OK: 5,000 finishes recorded in ${elapsed} ms`);
});

console.log('completed ledger tests passed');
