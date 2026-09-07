'use strict';
// Order service — orchestrates product lookup, payment charge, persistence.

const { createDatabase } = require('../db/database');
const { nextId } = require('../lib/legacyIds');
const { createProductService } = require('./productService');
const { createPaymentService } = require('./paymentService');

function createOrderService(dbDir) {
  const db = createDatabase(dbDir);
  const products = createProductService(dbDir);
  const payments = createPaymentService(dbDir);

  return {
    async createOrder({ items, userId }) {
      if (!Array.isArray(items) || items.length === 0) throw new Error('invalid_order');
      const catalog = db.read('products', []);

      const orderItems = items.map((item) => {
        const product = catalog.find((p) => p.id === Number(item.productId));
        if (!product) throw new Error('unknown_product');
        if (product.stock < item.quantity) throw new Error('insufficient_stock');
        return {
          productId: product.id,
          sku: product.sku,
          quantity: item.quantity,
          priceCents: product.priceCents,
        };
      });

      const totalCents = orderItems.reduce(
        (sum, it) => sum + it.priceCents * it.quantity,
        0
      );

      const charge = await payments.charge('pending', totalCents);

      const orders = db.read('orders', []);
      const order = {
        id: nextId(),
        userId: Number(userId) || null,
        items: orderItems,
        totalCents,
        status: 'paid',
        chargeTxId: charge.txId,
        createdAt: new Date().toISOString(),
      };
      orders.push(order);
      db.write('orders', orders);
      return order;
    },

    getOrder(id) {
      const orders = db.read('orders', []);
      return orders.find((o) => o.id === Number(id)) || null;
    },

    async refundOrder(id, amountCents) {
      const order = this.getOrder(id);
      if (!order) throw new Error('unknown_order');
      return payments.processRefund(order.id, amountCents);
    },

    // exposed for routes/tests
    payments,
    products,
  };
}

module.exports = { createOrderService };
