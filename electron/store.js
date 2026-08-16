/**
 * electron/store.js
 * Simple JSON-based persistent store — works synchronously, no ESM issues.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class SimpleStore {
  constructor(defaults = {}) {
    this._path = path.join(app.getPath('userData'), 'config.json');
    this._defaults = defaults;
    this._data = { ...defaults };
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this._path)) {
        const raw = fs.readFileSync(this._path, 'utf8');
        const parsed = JSON.parse(raw);
        this._data = { ...this._defaults, ...parsed };
      }
    } catch (e) {
      console.warn('[Store] Failed to load:', e.message);
    }
  }

  _save() {
    try {
      fs.writeFileSync(this._path, JSON.stringify(this._data, null, 2), 'utf8');
    } catch (e) {
      console.warn('[Store] Failed to save:', e.message);
    }
  }

  get(key) {
    return key in this._data ? this._data[key] : this._defaults[key];
  }

  set(key, value) {
    this._data[key] = value;
    this._save();
  }

  delete(key) {
    delete this._data[key];
    this._save();
  }

  clear() {
    this._data = { ...this._defaults };
    this._save();
  }
}

module.exports = SimpleStore;
