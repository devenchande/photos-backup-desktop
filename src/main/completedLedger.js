'use strict';

// The per-account record of files already backed up. Each finished file used
// to re-read and rewrite the whole record, which on a large library meant
// megabytes written per file (upstream iOS 6a9f02a hit the same wall). Now:
//
//   completed-<slug>.json  the record as of the last compaction
//   completed-<slug>.log   one JSON-encoded signature appended per finish
//
// The log is folded into the JSON the first time an account is loaded, and
// the record is then served from memory. A torn last line (the app stopped
// mid-write) is skipped; that file is simply checked with Google again.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function accountSlug(email) {
  return crypto.createHash('sha256').update(email || 'unknown').digest('hex').slice(0, 16);
}

class CompletedLedger {
  constructor(directory) {
    this.directory = directory;
    this.cache = new Map(); // slug -> Set of signatures
  }

  jsonPath(email) { return path.join(this.directory, `completed-${accountSlug(email)}.json`); }
  logPath(email) { return path.join(this.directory, `completed-${accountSlug(email)}.log`); }

  // The live set for an account, loading and compacting it on first use.
  set(email) {
    const slug = accountSlug(email);
    let signatures = this.cache.get(slug);
    if (signatures) return signatures;
    signatures = new Set();
    try {
      for (const sig of JSON.parse(fs.readFileSync(this.jsonPath(email), 'utf8')).signatures || []) signatures.add(sig);
    } catch { /* none yet, or unreadable: start empty */ }
    let logged = 0;
    try {
      for (const line of fs.readFileSync(this.logPath(email), 'utf8').split('\n')) {
        if (!line) continue;
        try { signatures.add(JSON.parse(line)); logged += 1; } catch { /* torn line */ }
      }
    } catch { /* no log */ }
    this.cache.set(slug, signatures);
    if (logged) this.compact(email, signatures);
    return signatures;
  }

  // Rewrite the JSON from memory (atomically) and start an empty log.
  compact(email, signatures = this.set(email)) {
    fs.mkdirSync(this.directory, { recursive: true });
    const target = this.jsonPath(email);
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ signatures: [...signatures] }));
    fs.renameSync(temp, target);
    try { fs.unlinkSync(this.logPath(email)); } catch { /* already gone */ }
  }

  load(email) { return new Set(this.set(email)); }

  has(email, sig) { return this.set(email).has(sig); }

  size(email) { return this.set(email).size; }

  add(email, sigs) {
    if (!email || !sigs.length) return;
    const signatures = this.set(email);
    const fresh = sigs.filter((sig) => !signatures.has(sig));
    if (!fresh.length) return;
    fs.mkdirSync(this.directory, { recursive: true });
    fs.appendFileSync(this.logPath(email), fresh.map((sig) => `${JSON.stringify(sig)}\n`).join(''));
    for (const sig of fresh) signatures.add(sig);
  }

  // Forget some files (chosen again by hand, say). Rare, so a compaction.
  remove(email, sigs) {
    if (!email || !sigs.length) return;
    const signatures = this.set(email);
    let changed = false;
    for (const sig of sigs) changed = signatures.delete(sig) || changed;
    if (changed) this.compact(email, signatures);
  }

  clear(email) {
    this.cache.delete(accountSlug(email));
    for (const file of [this.jsonPath(email), this.logPath(email)]) {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    }
  }
}

module.exports = { CompletedLedger, accountSlug };
