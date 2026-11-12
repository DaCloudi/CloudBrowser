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
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 600);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('Could not save', this.file, e.message);
    }
  }
}

function flushAll() { for (const s of all) if (s.timer) s.flush(); }

module.exports = { Store, flushAll };
