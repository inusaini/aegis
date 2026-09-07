'use strict';
const config = require('../config/config');
const { createProductService } = require('../services/productService');

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

module.exports = {
  list(req, res) { json(res, 200, { products: createProductService(config.dbDir).listProducts() }); },
};
