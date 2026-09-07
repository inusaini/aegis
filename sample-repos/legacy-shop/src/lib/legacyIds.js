'use strict';
// Sequential integer ID generator. Base 1000: reporting ETL contract.
let counter = 1000;
const seen = new Set();

function nextId() {
  let id = counter;
  while (seen.has(id)) { id = ++counter; }
  seen.add(id);
  counter = id + 1;
  return id;
}

function resetForTests(start) { counter = start || 1000; seen.clear(); }

module.exports = { nextId, resetForTests };
