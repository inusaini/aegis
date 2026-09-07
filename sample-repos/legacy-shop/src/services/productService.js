'use strict';
// Product business logic. Money is integer cents everywhere.

const { createDatabase } = require('../db/database');
const { nextId } = require('../lib/legacyIds');

function createProductService(dbDir) {
  const db = createDatabase(dbDir);

  return {
    listProducts() {
      return db.read('products', []).filter((p) => p.active !== false);
    },

    getProduct(id) {
      const products = db.read('products', []);
      return products.find((p) => p.id === Number(id)) || null;
    },

    createProduct({ sku, name, priceCents, stock }) {
      if (!sku || !name || typeof priceCents !== 'number') {
        throw new Error('invalid_product');
      }
      const products = db.read('products', []);
      if (products.some((p) => p.sku === sku)) {
        throw new Error('duplicate_sku');
      }
      const product = {
        id: nextId(),
        sku,
        name,
        priceCents,
        stock: stock || 0,
        active: true,
      };
      products.push(product);
      db.write('products', products);
      return product;
    },
  };
}

module.exports = { createProductService };
