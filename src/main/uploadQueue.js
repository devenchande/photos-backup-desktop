'use strict';

// Upload queue. The desktop counterpart of App/Sources/UploadQueue.swift:
// bounded-concurrency uploads with per-item progress (hash -> duplicate check
// -> send -> finalize), retry with the upstream's backoff schedule
// (min(30, 2^attempt)), a queue-wide halt when the credential is refused, and
// an account-scoped record of already-backed-up files.
//
// Desktop addition the upstream gets for free from iOS: when Google answers
// HTTP 429 (per-minute quota), a queue-wide cooldown pauses *new* item starts
// so one quota window does not burn the retry budget of every queued item.

const path = require('path');
const { GPMCClient, GPMCError } = require('./gpmc');
const { signature } = require('./settings');
const { captureDate } = require('./filenameDate');
const { eventLog } = require('./diagnostics');
const { PreparationMarkers, InterruptionCounters } = require('./preparationGuard');

const DEFAULT_CONCURRENCY = 2;
const MAX_ATTEMPTS = 3;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 10;
// Upstream: scheduleRetry(after: min(30, pow(2, attempt))) — 2s, 4s, 8s.
const backoffSeconds = (attempt) => Math.min(30, 2 ** attempt);
// A 429 pauses new starts for a minute, doubling while Google keeps refusing,
// up to ten times that, and back to a minute after the next success
// (upstream iOS d9b7afa).
const QUOTA_COOLDOWN_MS = 60000;
const QUOTA_COOLDOWN_GROWTH_LIMIT = 10;
// Above this many rows a snapshot carries only a window of them: everything
// running, failed rows up to a cap, the next waiting ones and the latest
// finished ones. The counts still cover every row (upstream iOS 6a9f02a).
const SNAPSHOT_ALL_ROWS = 400;
const SNAPSHOT_WAITING_ROWS = 50;
const SNAPSHOT_FAILED_ROWS = 200;
const SNAPSHOT_FINISHED_ROWS = 100;
const DONE = new Set(['uploaded', 'alreadyBackedUp']);
const MOTION_NOTES = {
  attached: 'Live Photo motion attached',
  alreadyAttached: 'Live Photo motion already attached',
  standalone: 'Its video is already in Google Photos as a separate video, so the motion was not attached',
};
// The completed-record entries a row stands for: a Live Photo is its still
// and its motion.
const signatures = (item) => (item.motion ? [signature(item), signature(item.motion)] : [signature(item)]);
const FINISHED = new Set(['uploaded', 'alreadyBackedUp', 'failed', 'cancelled']);
// Upstream recentFailureLimit: the newest failures the report lists.
const RECENT_FAILURE_LIMIT = 10;
// A file the process has died on this many times while preparing it is
// skipped, so one item that reliably takes the app down cannot stop every
// run from making progress on the rest (upstream interruptedPreparationLimit).
const INTERRUPTED_PREPARATION_LIMIT = 2;
const SKIP_REASON = 'Photos Backup closed unexpectedly more than once while '
  + 'preparing this file, so it was skipped to let the rest of the backup '
  + 'continue. Press Retry failed to try it again, and attach a diagnostic '
  + 'report if you report the problem.';

// The album a file goes into: its immediate parent folder's name, or
// "Uploads" (gotohp's fallback) for a file at a drive root.
const folderAlbumName = (filePath) => path.basename(path.dirname(filePath)) || 'Uploads';

const clampConcurrency = (n) => {
  const value = Number(n);
  return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY,
    Math.round(Number.isFinite(value) ? value : DEFAULT_CONCURRENCY)));
};

class UploadQueue {
  constructor({ credential, settings, onSnapshot, clientFactory, quotaCooldownMs = QUOTA_COOLDOWN_MS,
                markers = null, counters = null }) {
    this.clientFactory = clientFactory || ((authData) => new GPMCClient(authData));
    this.client = this.clientFactory(credential.authData);
    this.email = credential.email;
    this.settings = settings;
    this.onSnapshot = onSnapshot || (() => {});
    this.quotaCooldownMs = quotaCooldownMs;
    this.maxConcurrent = clampConcurrency(settings?.get?.('concurrency') ?? DEFAULT_CONCURRENCY);
    this.items = [];
    this.paused = false;
    this.cancelRequested = false;
    this.abort = new AbortController();
    this.snapTimer = null;
    this.haltReason = null;       // set when the credential is refused / storage is full
    this.cooldownUntil = 0;       // set when Google answers 429
    this.cooldownReason = null;
    this.quotaStrikes = 0;        // 429 pauses since the last success
    this.recentlyDone = [];       // newest finished rows, for the snapshot window
    this.retryTimers = new Set();
    // Crash-loop guard (upstream 0.3.6): markers name the files a previous
    // process died preparing; counters remember how often each file has done
    // so. Skips driven by the guard are counted for the diagnostic report.
    this.markers = markers || new PreparationMarkers();
    this.counters = counters || new InterruptionCounters();
    this.interrupted = this.markers.load();
    this.crashGuardSkipped = 0;
    this.recentFailures = [];
    // Album creations in flight, by name, so items from one folder running
    // side by side share one new album instead of each making their own.
    this.albumCreations = new Map();
  }

  // Upstream setMaxConcurrent: applying a lower limit lets in-flight work
  // finish; a higher one starts replacements on the next pump.
  setMaxConcurrent(n) {
    const clamped = clampConcurrency(n);
    if (clamped === this.maxConcurrent) return;
    this.maxConcurrent = clamped;
    this.pump();
  }

  // Replace the queue with a scan of the configured folders. Items already
  // recorded as completed for this account are skipped up front; the rest are
  // still hash-checked against Google's side before any bytes are sent.
  // `limit` mirrors the upstream's bounded batches (250 per foreground run).
  async enqueueScan(scanResults, limit = Infinity) {
    this.cancelRequested = false;
    // Files can now be added while uploads run; replacing a live controller
    // would leave those uploads out of reach of Cancel.
    if (this.abort.signal.aborted) this.abort = new AbortController();
    const completed = this.settings.loadCompleted(this.email);
    const existing = new Map(this.items.map((item) => [item.path, item]));
    // Pending = found items that are neither recorded as completed for this
    // account nor already sitting in the queue (as failed/cancelled rows).
    const pending = scanResults.filter((found) =>
      !completed.has(signature(found)) && !existing.has(found.path));
    // Crash-loop guard (upstream noteInterruptedPreparations): files the
    // previous process died preparing. Each goes to the back of the batch so
    // everything else gets a turn first, and a file that has now stopped the
    // app twice is skipped as non-retryable.
    const fresh = [];
    const movedToBack = [];
    let skipped = 0;
    for (const found of pending) {
      if (!this.interrupted.size || !this.interrupted.has(signature(found))) {
        fresh.push(found);
        continue;
      }
      const count = this.counters.bump(signature(found));
      if (count >= INTERRUPTED_PREPARATION_LIMIT) {
        skipped += 1;
        this.crashGuardSkipped += 1;
        this.items.push({
          ...found,
          status: 'failed',
          detail: null,
          error: SKIP_REASON,
          retryable: false,
          attempts: 0,
        });
      } else {
        movedToBack.push(found);
      }
    }
    this.interrupted = new Set();
    const batch = [...fresh, ...movedToBack].slice(0, limit);
    this.items = [...this.items, ...batch.map((found) => ({
      ...found,
      status: 'waiting',
      detail: null,
      error: null,
      attempts: 0,
    }))];
    if (skipped || movedToBack.length) {
      eventLog().record('queue',
        `The app stopped while preparing ${skipped + movedToBack.length} `
        + `file${skipped + movedToBack.length === 1 ? '' : 's'} last time; moved `
        + `${movedToBack.length} to the end of the queue and skipped ${skipped} `
        + `that had stopped it before`, 'warning');
    }
    if (batch.length) {
      eventLog().record('queue',
        `Queued ${batch.length} new file${batch.length === 1 ? '' : 's'}; `
        + `the queue holds ${this.items.length}, ${this.activeCount + this.summary().waiting} unfinished`);
    }
    this.emitSnapshot();
    this.pump();
    return { queued: batch.length, remaining: Math.max(0, pending.length - batch.length) };
  }

  // Files the user chose by hand: picked, dropped, or a folder to re-upload.
  // They are checked with Google again even when recorded as backed up
  // (upstream iOS 3cfc6ca), and with `forceUpload` they are uploaded again
  // even where Google already holds them (iOS 0.3.9 re-upload). Rows already
  // in the queue are requeued or marked rather than duplicated; rows running
  // now are left to finish.
  async enqueueChosen(found, { skipAlbum = false, forceUpload = false } = {}) {
    this.cancelRequested = false;
    if (this.abort.signal.aborted) this.abort = new AbortController();
    this.settings.forgetCompleted?.(this.email, found.flatMap(signatures));
    const rows = new Map(this.items.map((item) => [item.path, item]));
    const fresh = [];
    let requeued = 0;
    let running = 0;
    for (const file of found) {
      const row = rows.get(file.path);
      if (!row) {
        fresh.push({ ...file, skipAlbum, forceUpload });
      } else if (row.status === 'waiting' || FINISHED.has(row.status)) {
        Object.assign(row, {
          ...file,
          status: 'waiting',
          detail: null,
          error: null,
          attempts: 0,
          retryable: undefined,
          skipAlbum: skipAlbum && !!row.skipAlbum,
          forceUpload: forceUpload || (row.status === 'waiting' && !!row.forceUpload),
        });
        this.counters.clear(signature(row));
        requeued += 1;
      } else {
        running += 1;
      }
    }
    const { queued } = fresh.length ? await this.enqueueScan(fresh) : { queued: 0 };
    if (requeued) {
      eventLog().record('queue', `Queued ${requeued} chosen file${requeued === 1 ? '' : 's'} again`);
      this.emitSnapshot();
      this.pump();
    }
    return { queued: queued + requeued, alreadyDone: running + (fresh.length - queued) };
  }

  retryFailed() {
    this.haltReason = null;
    let retried = 0;
    for (const item of this.items) {
      if (item.status === 'failed' || item.status === 'cancelled') {
        item.status = 'waiting';
        item.error = null;
        item.attempts = 0;
        item.retryable = undefined;
        // A retry the user asked for gets a fresh allowance from the crash
        // guard (upstream requeue resets interruptedPreparations).
        this.counters.clear(signature(item));
        retried += 1;
      }
    }
    if (retried) eventLog().record('queue', `Retrying ${retried} failed or cancelled file${retried === 1 ? '' : 's'}`);
    this.cancelRequested = false;
    this.abort = new AbortController();
    this.emitSnapshot();
    this.pump();
  }

  // Upstream retryRetryableFailures(): requeue every failed row whose error
  // was transient (transport, 5xx, quota, invalid receipt) so the next run
  // picks them up without the user pressing anything. Permanent failures —
  // unreadable files, refused credentials — are left alone.
  releaseRetryableFailures() {
    let released = 0;
    for (const item of this.items) {
      if (item.status === 'failed' && item.retryable) {
        item.status = 'waiting';
        item.error = null;
        item.detail = 'released for retry';
        item.attempts = 0;
        released += 1;
      }
    }
    if (released) {
      this.haltReason = null;
      eventLog().record('queue', `Released ${released} failed file${released === 1 ? '' : 's'} for another attempt`);
      this.emitSnapshot();
      this.pump();
    }
    return released;
  }

  pause() { this.paused = true; eventLog().record('queue', 'You paused backup; uploads already running will finish'); this.emitSnapshot(); }
  resume() { this.paused = false; eventLog().record('queue', 'You resumed backup'); this.emitSnapshot(); this.pump(); }

  cancelAll() {
    const cancelled = this.items.filter((i) => i.status === 'waiting').length;
    this.cancelRequested = true;
    this.abort.abort();
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    for (const item of this.items) {
      if (item.status === 'waiting') item.status = 'cancelled';
    }
    eventLog().record('queue', `Cancel stopped the backup; ${cancelled} waiting file${cancelled === 1 ? '' : 's'} were cancelled`);
    this.emitSnapshot();
  }

  get activeCount() {
    return this.items.filter((i) => !['waiting', 'uploaded', 'alreadyBackedUp', 'failed', 'cancelled'].includes(i.status)).length;
  }

  get isIdle() {
    return this.items.every((i) => ['uploaded', 'alreadyBackedUp', 'failed', 'cancelled'].includes(i.status));
  }

  summary() {
    const counts = { total: this.items.length, waiting: 0, active: 0, uploaded: 0, alreadyBackedUp: 0, failed: 0, cancelled: 0 };
    for (const item of this.items) {
      if (item.status === 'waiting') counts.waiting += 1;
      else if (item.status === 'uploaded') counts.uploaded += 1;
      else if (item.status === 'alreadyBackedUp') counts.alreadyBackedUp += 1;
      else if (item.status === 'failed') counts.failed += 1;
      else if (item.status === 'cancelled') counts.cancelled += 1;
      else counts.active += 1;
    }
    return counts;
  }

  emitSnapshot() {
    if (this.snapTimer) return; // coalesce to one per tick
    this.snapTimer = setTimeout(() => {
      this.snapTimer = null;
      this.onSnapshot({
        counts: this.summary(),
        paused: this.paused,
        halted: this.haltReason,
        cooldownRemainingMs: this.cooldownUntil > Date.now() ? this.cooldownUntil - Date.now() : 0,
        cooldownReason: this.cooldownUntil > Date.now() ? this.cooldownReason : null,
        limited: this.items.length > SNAPSHOT_ALL_ROWS,
        items: this.snapshotRows().map((item) => ({
          path: item.path,
          filename: item.filename,
          size: item.size + (item.motion?.size || 0),
          motionFilename: item.motion?.filename || null,
          status: item.status,
          detail: item.detail || null,
          error: item.error || null,
          attempts: item.attempts,
        })),
      });
    }, 100);
  }

  // The rows a snapshot carries, in queue order. Small queues send them all; a
  // large one sends a window, so a big re-check does not ship and redraw tens
  // of thousands of rows several times a second.
  snapshotRows() {
    if (this.items.length <= SNAPSHOT_ALL_ROWS) return this.items;
    const chosen = new Set();
    let waiting = 0;
    let failed = 0;
    for (const item of this.items) {
      if (item.status === 'waiting') {
        if (waiting < SNAPSHOT_WAITING_ROWS) { chosen.add(item); waiting += 1; }
      } else if (item.status === 'failed' || item.status === 'cancelled') {
        if (failed < SNAPSHOT_FAILED_ROWS) { chosen.add(item); failed += 1; }
      } else if (!DONE.has(item.status)) {
        chosen.add(item); // running
      }
    }
    for (const item of this.recentlyDone) if (DONE.has(item.status)) chosen.add(item);
    return this.items.filter((item) => chosen.has(item));
  }

  noteDone(item) {
    this.recentlyDone = this.recentlyDone.filter((other) => other !== item);
    this.recentlyDone.push(item);
    if (this.recentlyDone.length > SNAPSHOT_FINISHED_ROWS) this.recentlyDone.shift();
  }

  // Upstream pump(): start queued work while slots are free, the queue is not
  // paused/halted, and any quota cooldown has elapsed.
  pump() {
    if (this.paused || this.cancelRequested || this.haltReason) return;
    if (this.cooldownUntil > Date.now()) {
      // Re-check when the cooldown lifts.
      this.scheduleCooldownWake();
      return;
    }
    const inFlight = this.items.filter((i) => this.isRunning(i.status)).length;
    let slots = this.maxConcurrent - inFlight;
    for (const item of this.items) {
      if (slots <= 0) break;
      if (item.status !== 'waiting') continue;
      slots -= 1;
      // Mark the item as being prepared *before* the work starts, and write
      // it synchronously: the crash this guards against can take the process
      // down at once (upstream marks until a prepared checkpoint for the same
      // reason). Cleared in runItem's finally.
      this.markers.add(signature(item));
      // Mark the item running synchronously, before any client callback can
      // run (upstream sets .exporting in start() for the same reason): a
      // later pump must not see it as waiting and start it twice.
      item.status = 'exporting';
      item.detail = null;
      this.runItem(item).catch(() => { /* runItem records its own failures */ });
    }
  }

  scheduleCooldownWake() {
    if (this.cooldownWake) return;
    const wait = Math.max(250, this.cooldownUntil - Date.now());
    this.cooldownWake = setTimeout(() => {
      this.cooldownWake = null;
      this.emitSnapshot();
      this.pump();
    }, wait);
    this.cooldownWake.unref?.();
  }

  isRunning(status) {
    return ['exporting', 'hashing', 'checkingDuplicate', 'preparing', 'sending', 'finalizing', 'addingToAlbum'].includes(status);
  }

  async runItem(item) {
    const storageSaver = !!this.settings.get('storageSaver');
    const useQuota = !!this.settings.get('useQuota');
    const modified = this.settings.get('dateFromFilename')
      ? captureDate(item.filename, item.mtimeMs)
      : new Date(item.mtimeMs);
    try {
      item.attempts += 1;
      const result = await this.client.upload(item.path, {
        filename: item.filename,
        modified,
        useQuota,
        saver: storageSaver,
        forceUpload: !!item.forceUpload,
        signal: this.abort.signal,
        onPhase: (phase) => this.showPhase(item, phase),
      });
      // A Live Photo's motion goes on once its still is in the account.
      const motionNote = item.motion
        ? await this.attachMotion(item, result, { modified, useQuota, saver: storageSaver })
        : null;
      // Filed before the item counts as completed: if this fails the item is
      // retried, and the retry's hash check finds the copy already uploaded.
      if (this.settings.get('albumsFromFolders') && result.mediaKey && !item.skipAlbum) {
        item.status = 'addingToAlbum';
        item.detail = folderAlbumName(item.path);
        this.emitSnapshot();
        await this.addToFolderAlbum(item, result.mediaKey, GPMCClient.commitProfile(useQuota, storageSaver).model);
      }
      // 'uploaded' | 'alreadyBackedUp'; a still found in the account counts as
      // uploaded when its motion went up just now.
      item.status = motionNote === MOTION_NOTES.attached ? 'uploaded' : result.outcome;
      const reuploadNote = item.forceUpload ? this.constructor.reuploadNote(result) : null;
      item.detail = [reuploadNote, motionNote].filter(Boolean).join(' · ') || null;
      item.error = null;
      if (item.forceUpload) {
        eventLog().record('reupload', `A re-upload finished: ${reuploadNote}`);
        item.forceUpload = false;
      }
      this.quotaStrikes = 0;
      this.noteDone(item);
      this.settings.markCompleted(this.email, signatures(item));
      // It made it through; any interruption count is stale.
      this.counters.clear(signature(item));
      this.emitSnapshot();
    } catch (error) {
      // What the item was doing when it failed, before the branches below
      // overwrite the status (upstream records the stage for the same reason).
      const stage = item.status;
      if (this.abort.signal.aborted || this.cancelRequested || error.message === 'aborted') {
        item.status = 'cancelled';
        item.detail = null;
      } else if (error instanceof GPMCError
                 && (error.kind === 'credentialRejected' || error.kind === 'tokenBound' || error.kind === 'storageFull')) {
        // Upstream: the item goes back to queued and the queue halts — no other
        // item can succeed until the account is reconnected (or storage is
        // freed, which only the user can do).
        item.status = 'waiting';
        item.detail = null;
        this.halt(error);
      } else {
        const retryable = error instanceof GPMCError && error.retryable;
        if (error instanceof GPMCError && error.statusCode === 429) {
          // A rate limit says nothing about this file, so it gets its attempt
          // back and waits out the queue-wide pause (upstream iOS d9b7afa).
          item.attempts -= 1;
          item.status = 'waiting';
          item.error = null;
          item.detail = "waiting out Google's rate limit";
          this.noteQuotaRejection();
        } else if (retryable && item.attempts < MAX_ATTEMPTS) {
          item.status = 'waiting';
          item.error = null;
          item.detail = `attempt ${item.attempts} failed (${this.shortReason(error)}); retrying`;
          this.scheduleRetry(item, backoffSeconds(item.attempts));
          // No attempt number, so a burst of the same failure folds into a
          // single timeline entry (upstream does the same).
          eventLog().record('upload',
            `Will retry an upload after a temporary failure while ${this.constructor.stageDescription(stage)}: ${error.message}`,
            'warning');
        } else {
          item.status = 'failed';
          item.retryable = !!retryable;
          item.error = error.message;
          item.detail = null;
          this.recordFailure(item, error, stage);
        }
      }
      this.emitSnapshot();
    } finally {
      // The attempt ended; the crash guard no longer watches this file.
      this.markers.remove(signature(item));
      this.pump();
    }
  }

  // Reflect a client phase on the row. `prefix` marks the Live Photo motion's
  // phases, which run on the same row after the still's.
  showPhase(item, phase, prefix = '') {
    if (this.abort.signal.aborted) return;
    item.status = phase.phase === 'sending' ? 'sending'
      : phase.phase === 'hashing' ? 'hashing'
      : phase.phase === 'checkingDuplicate' ? 'checkingDuplicate'
      : phase.phase === 'preparing' ? 'preparing'
      : 'finalizing';
    const detail = phase.phase === 'hashing' ? `${Math.round((phase.fraction || 0) * 100)}% hashed`
      : phase.phase === 'sending' ? `${this.formatBytes(phase.sent)} / ${this.formatBytes(phase.total)}`
      : null;
    item.detail = prefix ? `${prefix}${detail ? ` · ${detail}` : ''}` : detail;
    this.emitSnapshot();
  }

  // Attach a Live Photo's motion to its still, which `still` (the still's
  // upload result) has just put in, or found in, the account (iOS 0.3.9 Back
  // Up Live Photo Motion). Returns the row's note. A transient failure throws
  // so the row retries: the still then resolves at once and only the motion
  // repeats. A permanent refusal does not: the photo is backed up, so the row
  // finishes and says the motion was refused.
  async attachMotion(item, still, { modified, useQuota, saver }) {
    try {
      const motion = await this.client.uploadMotion(item.motion.path, {
        stillHash: still.hash,
        filename: item.motion.filename,
        modified,
        useQuota,
        saver,
        signal: this.abort.signal,
        onPhase: (phase) => this.showPhase(item, phase, 'Live Photo motion'),
      });
      if (motion.outcome === 'attached' && motion.mediaKey !== still.mediaKey) {
        eventLog().record('livePhoto', "Google answered a motion with a media key other than its photo's", 'warning');
      }
      eventLog().record('livePhoto', `A Live Photo motion finished: ${motion.outcome}`);
      return MOTION_NOTES[motion.outcome];
    } catch (error) {
      if (error instanceof GPMCError && (error.kind === 'malformed' || (error.kind === 'server' && !error.retryable))) {
        eventLog().record('livePhoto', `Google refused a Live Photo motion: ${error.message}`, 'warning');
        return `Photo backed up; its Live Photo motion was refused: ${error.message}`;
      }
      throw error;
    }
  }

  // Put one media item into the album named after the file's folder, creating
  // the album the first time that name is seen for this account.
  async addToFolderAlbum(item, mediaKey, model) {
    const name = folderAlbumName(item.path);
    const pending = this.albumCreations.get(name);
    if (pending) {
      const key = await pending;
      await this.client.addMediaToAlbum(key, [mediaKey], { model });
      return;
    }
    const known = this.settings.albumKey(this.email, name);
    if (known) {
      try {
        await this.client.addMediaToAlbum(known, [mediaKey], { model });
        return;
      } catch (error) {
        // A permanent refusal most likely means the album was deleted in
        // Google Photos; forget it and make a new one below. Transient and
        // credential errors go to runItem's usual handling.
        if (!(error instanceof GPMCError) || error.kind !== 'server' || error.retryable) throw error;
        // Another upload from this folder may have met the same refusal while
        // this one waited, and be making, or have saved, the replacement.
        const replacing = this.albumCreations.get(name);
        if (replacing) {
          await this.client.addMediaToAlbum(await replacing, [mediaKey], { model });
          return;
        }
        const replacement = this.settings.albumKey(this.email, name);
        if (replacement && replacement !== known) {
          await this.client.addMediaToAlbum(replacement, [mediaKey], { model });
          return;
        }
        this.saveAlbumKey(name, null);
        eventLog().record('album', `Google refused a saved album, so a new one will be made: ${error.message}`, 'warning');
      }
    }
    // The new album is created holding this item, as gotohp does.
    const creation = this.client.createAlbum(name, [mediaKey], { model })
      .then((key) => {
        this.saveAlbumKey(name, key);
        eventLog().record('album', 'Created an album for a backed-up folder');
        return key;
      })
      .finally(() => this.albumCreations.delete(name));
    this.albumCreations.set(name, creation);
    await creation;
  }

  // A record that cannot be written must not fail an upload that worked: the
  // item is in its album; the next upload from that folder makes another.
  saveAlbumKey(name, key) {
    try {
      this.settings.saveAlbum(this.email, name, key);
    } catch (error) {
      eventLog().record('album', `Could not save an album record: ${error.message}`, 'error');
    }
  }

  // What a re-upload came back with. The same media key means Google kept the
  // copy it already had, so the storage it uses probably did not change; a
  // new key means a new item, and the earlier copy may still use storage.
  static reuploadNote(result) {
    if (!result.previousKey) return 'Re-uploaded; Google had no copy of it';
    return result.mediaKey === result.previousKey
      ? 'Re-uploaded; Google kept the copy it already had'
      : 'Re-uploaded as a new item; the earlier copy may still use storage';
  }

  // Keep the newest failures and drop the oldest, so a long backup that goes
  // wrong in one way does not bury the one that went wrong differently
  // (upstream recordFailure). The filename stays out of the event log; the
  // stage says where it went wrong, Google's code says what Google said.
  recordFailure(item, error, stage) {
    this.recentFailures.unshift({
      date: Date.now(),
      reason: error.message,
      statusCode: error instanceof GPMCError ? (error.status?.rawCode ?? error.statusCode ?? null) : null,
    });
    if (this.recentFailures.length > RECENT_FAILURE_LIMIT) this.recentFailures.pop();
    const during = stage ? ` while ${this.constructor.stageDescription(stage)}` : '';
    const code = error instanceof GPMCError && error.status?.rawCode
      ? ` [Google code ${error.status.rawCode}]` : '';
    eventLog().record('upload', `An upload failed${during}${code}: ${error.message}`, 'error');
  }

  // What an item was doing, for a sentence that says where a failure happened
  // (upstream stageDescription, adapted to the desktop's phase names).
  static stageDescription(status) {
    switch (status) {
      case 'hashing': return 'reading the file';
      case 'checkingDuplicate': return 'asking Google for an existing copy';
      case 'preparing': return 'reserving the upload';
      case 'sending': return 'uploading';
      case 'finalizing': return 'finishing it in Google Photos';
      case 'addingToAlbum': return "adding it to its folder's album";
      default: return 'starting';
    }
  }

  shortReason(error) {
    return error instanceof GPMCError ? `HTTP ${error.statusCode || error.kind}` : error.message;
  }

  scheduleRetry(item, seconds) {
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      if (item.status === 'waiting') this.pump();
    }, seconds * 1000);
    timer.unref?.();
    this.retryTimers.add(timer);
  }

  halt(error) {
    if (this.haltReason) return;
    this.haltReason = error.message;
    // Upstream wording: the two halts a user can act on differently.
    eventLog().record('queue',
      error.kind === 'storageFull'
        ? 'Stopped the queue: the Google account is out of storage, so no other upload can succeed'
        : 'Stopped the queue: Google refused the credential, so no other upload can succeed until the account is connected again',
      'error');
    // Requeue anything in flight; a reconnect (new queue) or Retry resumes.
    this.abort.abort();
    this.abort = new AbortController();
    this.emitSnapshot();
  }

  formatBytes(n) {
    if (!Number.isFinite(n)) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = n;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
  }

  // Called when a request came back with HTTP 429: pause new item starts for
  // a minute so the quota window can reset without burning every item's
  // retry budget.
  noteQuotaRejection() {
    // Uploads running side by side meet the same limit; only the first
    // refusal of a window sets the pause.
    if (this.cooldownUntil > Date.now()) return;
    const wait = Math.min(this.quotaCooldownMs * QUOTA_COOLDOWN_GROWTH_LIMIT,
      this.quotaCooldownMs * 2 ** this.quotaStrikes);
    this.quotaStrikes += 1;
    this.cooldownUntil = Date.now() + wait;
    const minutes = Math.max(1, Math.round(wait / 60000));
    const span = `${minutes} minute${minutes === 1 ? '' : 's'}`;
    this.cooldownReason = `Google rate limit (429) — pausing new uploads for ${span}`;
    eventLog().record('queue', `Google rate limit (429); pausing new upload starts for ${span}`);
    this.emitSnapshot();
  }

  // Everything the diagnostic report shows about the queue.
  diagnosticInfo() {
    let completedCount = null;
    try {
      completedCount = this.settings.completedCount?.(this.email) ?? this.settings.loadCompleted(this.email).size;
    } catch { /* report only */ }
    return {
      counts: this.summary(),
      halted: this.haltReason,
      paused: this.paused,
      cooldownRemainingMs: this.cooldownUntil > Date.now() ? this.cooldownUntil - Date.now() : 0,
      maxConcurrent: this.maxConcurrent,
      crashGuardSkipped: this.crashGuardSkipped,
      completedCount,
      recentFailures: this.recentFailures.map((failure) => ({ ...failure })),
    };
  }

  // A graceful quit is not a crash: drop the preparation markers so the files
  // in flight are not counted against the guard next launch (upstream disarms
  // the guard before suspension for the same reason).
  clearPreparationMarkers() {
    this.interrupted = new Set();
    this.markers.clear();
  }
}

module.exports = {
  UploadQueue, backoffSeconds, clampConcurrency, folderAlbumName,
  DEFAULT_CONCURRENCY, MAX_ATTEMPTS,
  INTERRUPTED_PREPARATION_LIMIT, SKIP_REASON,
};
