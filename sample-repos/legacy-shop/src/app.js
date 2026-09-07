'use strict';
// legacy-shop entrypoint. Hand-rolled router - no framework on purpose.

const http = require('http');
const config = require('./config/config');

const routes = {
  products: require('./routes/products'),
  orders: require('./routes/orders'),
  auth: require('./routes/auth'),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean);
  const body = await readBody(req);
  try {
    if (parts[0] === 'products') {
      if (parts.length === 2 && req.method === 'GET') return routes.products.getById(req, res, parts[1]);
      if (parts.length === 1 && req.method === 'GET') return routes.products.list(req, res, url);
      if (parts.length === 1 && req.method === 'POST') return routes.products.create(req, res, body);
    }
    if (parts[0] === 'orders') {
      if (parts.length === 2 && req.method === 'GET') return routes.orders.getById(req, res, parts[1]);
      if (parts.length === 1 && req.method === 'POST') return routes.orders.create(req, res, body);
    }
    if (url.pathname === '/login' && req.method === 'POST') return routes.auth.login(req, res, body);
    if (url.pathname === '/register' && req.method === 'POST') return routes.auth.register(req, res, body);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal_error', message: String(err && err.message) }));
  }
});

function readBody(req) {
  return new Promise((resolve) => {
    if (req.method !== 'POST' && req.method !== 'PUT') return resolve(null);
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : null); } catch { resolve(null); } });
  });
}

if (require.main === module) {
  server.listen(config.port, () => console.log(`legacy-shop listening on ${config.port}`));
}

module.exports = { server, routes };
