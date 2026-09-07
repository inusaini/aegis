'use strict';
// Order routes. Manual validation.

const config = require('../config/config');
const { createOrderService } = require('../services/orderService');

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function service() {
  return createOrderService(config.dbDir);
}

module.exports = {
  async create(req, res, body) {
    try {
      const order = await service().createOrder(body || {});
      json(res, 201, { order });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
  },

  getById(req, res, id) {
    const order = service().getOrder(id);
    if (!order) return json(res, 404, { error: 'not_found' });
    json(res, 200, { order });
  },

  // POST /orders/refunds  { orderId, amountCents }
  // NOTE: passes through token auth only informally (2015 behavior, kept).
  async refund(req, res, body) {
    try {
      const { orderId, amountCents } = body || {};
      const result = await service().refundOrder(orderId, amountCents);
      json(res, 200, { refund: result });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
  },
};
