// Tiny JSON file store kept in the app's user-data folder.
'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const all = [];

class Store {
  constructor(name, defaults) {
    this.file = path.join(app.getPath('userData'), `${name}.json`);
    this.timer = null;
    let loaded = null;
    try { loaded = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run or unreadable */ }
    this.data = (loaded && typeof loaded === 'object' && !Array.isArray(loaded))
      ? { ...structuredClone(defaults), ...loaded }
      : structuredClone(defaults);
    all.push(this);
  }

  save() {
    // Writes are batched, and happen off the main thread, so saving never stutters the browser.
    clearTimeout(this.timer);
    if (!this.firstPending) this.firstPending = Date.now();
    const wait = Date.now() - this.firstPending > 5000 ? 0 : 800; // but never put off for more than ~5 s
    this.timer = setTimeout(() => this.flushAsync(), wait);
  }

  async flushAsync() {
    clearTimeout(this.timer);
    this.timer = null;
    this.firstPending = 0;
    if (this.writing) { this.again = true; return; }
    this.writing = true;
    try {
      const body = JSON.stringify(this.data);
      if (body !== this.lastWritten) {
        await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
        const tmp = this.file + '.tmp';
        await fs.promises.writeFile(tmp, body);
        await fs.promises.rename(tmp, this.file);
        this.lastWritten = body;
      }
    } catch (e) {
      console.error('Could not save', this.file, e.message);
    } finally {
      this.writing = false;
      if (this.again) { this.again = false; this.save(); }
    }
  }

  // Synchronous write, for quitting.
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    this.firstPending = 0;
    try {
      const body = JSON.stringify(this.data);
      if (body === this.lastWritten && !this.again) return;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.sync.tmp';
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, this.file);
      this.lastWritten = body;
    } catch (e) {
      console.error('Could not save', this.file, e.message);
    }
  }
}

function flushAll() { for (const s of all) if (s.timer || s.writing || s.again) s.flush(); }

module.exports = { Store, flushAll };
