'use strict';
// Product service tests. Run: node --test tests/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createProductService } = require('../src/services/productService');

function makeTempDbDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-shop-test-'));
  // seed with the catalog from src/db
  const products = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'products.json'), 'utf8')
  );
  fs.writeFileSync(path.join(dir, 'products.json'), JSON.stringify(products));
  return dir;
}

test('listProducts returns only active products', () => {
  const svc = createProductService(makeTempDbDir());
  const products = svc.listProducts();
  assert.ok(products.length >= 3);
  assert.ok(products.every((p) => p.active !== false));
});

test('getProduct returns product by id', () => {
  const svc = createProductService(makeTempDbDir());
  const product = svc.getProduct(1001);
  assert.strictEqual(product.sku, 'KB-100');
});

test('getProduct returns null for unknown id', () => {
  const svc = createProductService(makeTempDbDir());
  assert.strictEqual(svc.getProduct(999999), null);
});

test('createProduct assigns sequential integer id above 1000', () => {
  const svc = createProductService(makeTempDbDir());
  const product = svc.createProduct({ sku: 'TE-001', name: 'Test item', priceCents: 100 });
  assert.ok(product.id >= 1000);
  assert.strictEqual(typeof product.id, 'number');
});

test('createProduct rejects duplicate sku', () => {
  const svc = createProductService(makeTempDbDir());
  assert.throws(() => svc.createProduct({ sku: 'KB-100', name: 'dup', priceCents: 1 }), /duplicate_sku/);
});
