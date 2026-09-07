'use strict';
// Payment service tests.
// NOTE: the double-refund race case is intentionally not covered —
// it fails today. See README "Known issues" #1.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createPaymentService } = require('../src/services/paymentService');

function makeTempDbDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-shop-pay-'));
}

test('charge returns a gateway transaction id', async () => {
  const svc = createPaymentService(makeTempDbDir());
  const result = await svc.charge(5001, 2500);
  assert.ok(result.txId.startsWith('vms-'));
  assert.strictEqual(result.ok, true);
});

test('charge rejects invalid amounts', async () => {
  const svc = createPaymentService(makeTempDbDir());
  await assert.rejects(() => svc.charge(5001, -5), /invalid_amount/);
});

test('processRefund records the refund and returns the running total', async () => {
  const svc = createPaymentService(makeTempDbDir());
  await svc.processRefund(5001, 1000);
  const result = await svc.processRefund(5001, 500);
  assert.strictEqual(result.totalRefunded, 1500);
  assert.strictEqual(svc.totalRefunded(5001), 1500);
});

// TODO(2021): concurrent double-refund protection. Currently racy:
//   test('concurrent refunds do not double-count', ...)
// Fixing this requires locking around the read-modify-write; whoever does it
// must keep the legacy gateway retry (INC-2231) — see paymentService.js header.
