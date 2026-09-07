'use strict';
// JSON file persistence. Synchronous IO on purpose (see commit history).
const fs = require('fs');
const path = require('path');

function loadFile(dbDir, name, fallback) {
  const file = path.join(dbDir, name + '.json');
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveFile(dbDir, name, data) {
  const file = path.join(dbDir, name + '.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function createDatabase(dbDir) {
  return {
    read(table, fallback) { return loadFile(dbDir, table, fallback || []); },
    write(table, data) { saveFile(dbDir, table, data); },
  };
}

module.exports = { createDatabase, loadFile, saveFile };
