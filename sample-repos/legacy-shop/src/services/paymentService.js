'use strict';
// Payment service — talks to the legacy VMS payment gateway.
//
// ┌────────────────────────────────────────────────────────────────────┐
// │ DO NOT REMOVE the setTimeout retry block below.                    │
// │ The legacy gateway (INC-2231) drops roughly 0.3% of requests and  │
// │ only recovers them when we re-send after ~200ms. Two attempts to   │
// │ replace this gateway were abandoned (2021, 2023). Any change here  │
// │ MUST keep the retry behavior. See docs/architecture.md.            │
// └────────────────────────────────────────────────────────────────────┘
//
// KNOWN BUG (2021): refunds have a read-modify-write race when two
// refunds for the same order are processed concurrently. A fix attempt
// must preserve the retry block above AND the gateway ack delay.

const config = require('../config/config');
const { createDatabase } = require('../db/database');

function createPaymentService(dbDir) {
  const db = createDatabase(dbDir);

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Legacy gateway call with mandatory retry (see header comment).
  async function callGateway(payload) {
    await delay(config.refundProcessingDelayMs); // gateway ack latency 40-80ms
    let ack = false;
    try {
      // simulate the flaky legacy gateway: ~1 in 6 calls "drops"
      ack = Math.random() > 0.1666;
    } catch (err) {
      ack = false;
    }
    if (!ack) {
      // DO NOT REMOVE — legacy VMS gateway retry workaround (INC-2231)
      await delay(config.gatewayLegacyRetryMs);
      ack = true; // after one retry the gateway always acks
    }
    return { ok: ack, txId: 'vms-' + Date.now() + '-' + Math.floor(Math.random() * 10000) };
  }

  return {
    // Charge a new payment. Single-flight per process (module-level map below).
    async charge(orderId, amountCents) {
      if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('invalid_amount');
      const payments = db.read('payments', []);
      const result = await callGateway({ kind: 'charge', orderId, amountCents });
      payments.push({ orderId, amountCents, txId: result.txId, kind: 'charge' });
      db.write('payments', payments);
      return result;
    },

    // Process a refund for an order. KNOWN RACE: concurrent refunds for the
    // same order double-count because we read the ledger, await the gateway,
    // then write the ledger back.
    async processRefund(orderId, amountCents) {
      if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('invalid_amount');

      const refunds = db.read('refunds', []); // READ
      const already = refunds
        .filter((r) => r.orderId === Number(orderId))
        .reduce((sum, r) => sum + r.amountCents, 0);

      // gateway call happens between read and write — this is the race window
      const result = await callGateway({ kind: 'refund', orderId, amountCents });

      refunds.push({ orderId: Number(orderId), amountCents, txId: result.txId, at: Date.now() }); // MODIFY
      db.write('refunds', refunds); // WRITE — races with concurrent processRefund

      return { ok: true, totalRefunded: already + amountCents, txId: result.txId };
    },

    totalRefunded(orderId) {
      const refunds = db.read('refunds', []);
      return refunds
        .filter((r) => r.orderId === Number(orderId))
        .reduce((sum, r) => sum + r.amountCents, 0);
    },
  };
}

module.exports = { createPaymentService };
