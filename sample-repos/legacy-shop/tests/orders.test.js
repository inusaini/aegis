'use strict';
// Order service tests (end-to-end through the service layer).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createOrderService } = require('../src/services/orderService');

function makeTempDbDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-shop-order-'));
  const products = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'products.json'), 'utf8')
  );
  fs.writeFileSync(path.join(dir, 'products.json'), JSON.stringify(products));
  return dir;
}

test('createOrder computes total from catalog prices', async () => {
  const svc = createOrderService(makeTempDbDir());
  const order = await svc.createOrder({
    userId: 1,
    items: [{ productId: 1001, quantity: 2 }, { productId: 1002, quantity: 1 }],
  });
  assert.strictEqual(order.totalCents, 7999 * 2 + 3499);
  assert.strictEqual(order.status, 'paid');
});

test('createOrder rejects unknown product', async () => {
  const svc = createOrderService(makeTempDbDir());
  await assert.rejects(
    () => svc.createOrder({ items: [{ productId: 999999, quantity: 1 }] }),
    /unknown_product/
  );
});

test('createOrder rejects insufficient stock', async () => {
  const svc = createOrderService(makeTempDbDir());
  await assert.rejects(
    () => svc.createOrder({ items: [{ productId: 1003, quantity: 1 }] }), // stock 0
    /insufficient_stock/
  );
});

test('refundOrder delegates to paymentService', async () => {
  const svc = createOrderService(makeTempDbDir());
  const order = await svc.createOrder({ items: [{ productId: 1001, quantity: 1 }] });
  const refund = await svc.refundOrder(order.id, 500);
  assert.ok(refund.txId.startsWith('vms-'));
});
