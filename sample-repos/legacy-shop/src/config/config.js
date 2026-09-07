'use strict';
// Environment-driven configuration.
// PORT default is 3001: the load balancer in front of us expects 3001.
// Changing the default requires an ops change ticket (see README).

module.exports = {
  port: Number(process.env.PORT || 3001),
  dbDir: process.env.DB_DIR || require('path').join(__dirname, '..', 'db'),
  tokenSecret: process.env.TOKEN_SECRET || 'legacy-shop-dev-secret',
  // payment gateway legacy mode - see paymentService.js
  gatewayLegacyRetryMs: Number(process.env.GATEWAY_RETRY_MS || 200),
  refundProcessingDelayMs: Number(process.env.REFUND_DELAY_MS || 50),
};
