#!/usr/bin/env node
/**
 * Builds (or rebuilds) the sample brownfield repository with a realistic
 * Git history. The final working tree is identical to what already exists
 * in sample-repos/legacy-shop; intermediate commits are staged versions so
 * that `git blame` / `git log` carry real brownfield context.
 *
 * Usage: node scripts/create-sample-repo.ts
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..', 'sample-repos', 'legacy-shop');
const IS_WINDOWS = process.platform === 'win32';

function sh(cmd, opts = {}) {
  // Explicit shell binary: Bun's execSync defaults to /bin/sh, which does
  // not exist on Windows (spawnSync /bin/sh ENOENT).
  const file = IS_WINDOWS ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
  const args = IS_WINDOWS ? ['/d', '/s', '/c', cmd] : ['-c', cmd];
  const res = spawnSync(file, args, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    ...opts,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const err = new Error(`Command failed (${res.status}): ${cmd}\n${(res.stderr || '').slice(0, 500)}`);
    err.stdout = res.stdout || '';
    err.stderr = res.stderr || '';
    throw err;
  }
  return (res.stdout || '').toString();
}

function write(rel, content) {
  const file = path.join(REPO, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function commit(date, message) {
  sh('git add -A');
  sh(`git -c user.name="Legacy Shop Team" -c user.email="dev@legacy-shop.example" commit --date="${date}" -m ${JSON.stringify(message)}`);
}

// ---- 1. Snapshot final state -------------------------------------------
const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-shop-final-'));
fs.cpSync(REPO, snapshot, { recursive: true, filter: (f) => !f.includes('.git') });
// wipe existing history AND working tree (snapshot holds the final state)
fs.rmSync(path.join(REPO, '.git'), { recursive: true, force: true });
for (const entry of fs.readdirSync(REPO)) {
  if (entry !== '.git') fs.rmSync(path.join(REPO, entry), { recursive: true, force: true });
}

sh('git init -b main');
write('.gitignore', 'node_modules/\n*.log\n.DS_Store\n');
commit('2015-03-10T09:14:00', 'Initial import of legacy order system from VMS era codebase');

// ---- 2. Core skeleton (v0.1 style) ---------------------------------------
write('package.json', JSON.stringify({
  name: 'legacy-shop', version: '0.1.0',
  description: 'Legacy order management backend (VMS era import)',
  main: 'src/app.js', scripts: { start: 'node src/app.js' }, license: 'MIT',
}, null, 2) + '\n');

write('src/db/database.js', `'use strict';
// JSON file persistence. Synchronous IO on purpose (see commit history).
const fs = require('fs');
const path = require('path');

function loadFile(dbDir, name, fallback) {
  const file = path.join(dbDir, name + '.json');
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveFile(dbDir, name, data) {
  const file = path.join(dbDir, name + '.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function createDatabase(dbDir) {
  return {
    read(table, fallback) { return loadFile(dbDir, table, fallback || []); },
    write(table, data) { saveFile(dbDir, table, data); },
  };
}

module.exports = { createDatabase, loadFile, saveFile };
`);
commit('2015-03-10T09:41:00', 'Add JSON file persistence layer (sync IO for the NFS mount)');

write('src/lib/legacyIds.js', `'use strict';
// Sequential integer ID generator. Base 1000: reporting ETL contract.
let counter = 1000;
const seen = new Set();

function nextId() {
  let id = counter;
  while (seen.has(id)) { id = ++counter; }
  seen.add(id);
  counter = id + 1;
  return id;
}

function resetForTests(start) { counter = start || 1000; seen.clear(); }

module.exports = { nextId, resetForTests };
`);
commit('2015-03-11T14:02:00', 'Add legacy integer ID scheme (base 1000 for reporting ETL)');

// ---- 3. Router + products ------------------------------------------------
write('src/app.js', `'use strict';
const http = require('http');
const routes = { products: require('./routes/products') };

const server = http.createServer((req, res) => {
  const parts = req.url.split('/').filter(Boolean);
  if (parts[0] === 'products') return routes.products.list(req, res);
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

if (require.main === module) server.listen(3001);
module.exports = { server, routes };
`);
commit('2015-03-11T15:20:00', 'Add basic HTTP routing (no framework - 2015 constraint)');

write('src/db/products.json', fs.readFileSync(path.join(snapshot, 'src/db/products.json')));
write('src/services/productService.js', fs.readFileSync(path.join(snapshot, 'src/services/productService.js')));
write('src/routes/products.js', `'use strict';
const config = require('../config/config');
const { createProductService } = require('../services/productService');

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

module.exports = {
  list(req, res) { json(res, 200, { products: createProductService(config.dbDir).listProducts() }); },
};
`);
commit('2016-09-02T11:33:00', 'Add product catalog with JSON persistence');

// ---- 4. Auth ------------------------------------------------------------
write('src/lib/tokens.js', fs.readFileSync(path.join(snapshot, 'src/lib/tokens.js')));
write('src/db/users.json', fs.readFileSync(path.join(snapshot, 'src/db/users.json')));
write('src/services/authService.js', `'use strict';
// Magic-link era auth: emails only, no passwords yet.
const { createDatabase } = require('../db/database');
const { nextId } = require('../lib/legacyIds');

function createAuthService(dbDir) {
  const db = createDatabase(dbDir);
  return {
    register({ email, name, role }) {
      if (!email || !email.includes('@')) throw new Error('invalid_email');
      const users = db.read('users', []);
      if (users.some((u) => u.email === email)) throw new Error('duplicate_user');
      const user = { id: nextId(), email, name: name || email.split('@')[0], role: role === 'admin' ? 'admin' : 'member' };
      users.push(user);
      db.write('users', users);
      return user;
    },
  };
}

module.exports = { createAuthService };
`);
write('src/routes/auth.js', `'use strict';
const config = require('../config/config');
const { createAuthService } = require('../services/authService');

module.exports = {
  async register(req, res, body) {
    const user = createAuthService(config.dbDir).register(body || {});
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ user }));
  },
};
`);
commit('2018-04-17T10:12:00', 'Add magic-link authentication with tokens');

write('src/services/authService.js', fs.readFileSync(path.join(snapshot, 'src/services/authService.js')));
write('src/routes/auth.js', fs.readFileSync(path.join(snapshot, 'src/routes/auth.js')));
commit('2019-01-22T16:45:00', 'Migrate auth to password-based login (hash with sha256)');

// ---- 5. Orders ----------------------------------------------------------
write('src/services/orderService.js', `'use strict';
const { createDatabase } = require('../db/database');
const { nextId } = require('../lib/legacyIds');
const { createProductService } = require('./productService');

function createOrderService(dbDir) {
  const db = createDatabase(dbDir);
  const products = createProductService(dbDir);
  return {
    createOrder({ items, userId }) {
      if (!Array.isArray(items) || items.length === 0) throw new Error('invalid_order');
      const catalog = db.read('products', []);
      const orderItems = items.map((item) => {
        const product = catalog.find((p) => p.id === Number(item.productId));
        if (!product) throw new Error('unknown_product');
        if (product.stock < item.quantity) throw new Error('insufficient_stock');
        return { productId: product.id, sku: product.sku, quantity: item.quantity, priceCents: product.priceCents };
      });
      const totalCents = orderItems.reduce((sum, it) => sum + it.priceCents * it.quantity, 0);
      const orders = db.read('orders', []);
      const order = { id: nextId(), userId: Number(userId) || null, items: orderItems, totalCents, status: 'created', createdAt: new Date().toISOString() };
      orders.push(order);
      db.write('orders', orders);
      return order;
    },
    getOrder(id) { return db.read('orders', []).find((o) => o.id === Number(id)) || null; },
  };
}

module.exports = { createOrderService };
`);
commit('2020-06-30T13:27:00', 'Add order service with stock checks (no payment yet)');

// ---- 6. Payment v1 (clean, no retry) ------------------------------------
write('src/services/paymentService.js', `'use strict';
// Payment service - talks to the VMS payment gateway.

const config = require('../config/config');
const { createDatabase } = require('../db/database');

function createPaymentService(dbDir) {
  const db = createDatabase(dbDir);

  function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  async function callGateway(payload) {
    await delay(config.refundProcessingDelayMs);
    return { ok: true, txId: 'vms-' + Date.now() + '-' + Math.floor(Math.random() * 10000) };
  }

  return {
    async charge(orderId, amountCents) {
      if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('invalid_amount');
      const payments = db.read('payments', []);
      const result = await callGateway({ kind: 'charge', orderId, amountCents });
      payments.push({ orderId, amountCents, txId: result.txId, kind: 'charge' });
      db.write('payments', payments);
      return result;
    },
  };
}

module.exports = { createPaymentService };
`);
write('src/config/config.js', `'use strict';
// Environment-driven configuration.
module.exports = {
  port: Number(process.env.PORT || 3001),
  dbDir: process.env.DB_DIR || require('path').join(__dirname, '..', 'db'),
  tokenSecret: process.env.TOKEN_SECRET || 'legacy-shop-dev-secret',
  refundProcessingDelayMs: Number(process.env.REFUND_DELAY_MS || 50),
};
`);
write('src/routes/orders.js', fs.readFileSync(path.join(snapshot, 'src/routes/orders.js')));
write('src/services/orderService.js', fs.readFileSync(path.join(snapshot, 'src/services/orderService.js')));
write('src/app.js', `'use strict';
// legacy-shop entrypoint. Hand-rolled router - no framework on purpose.

const http = require('http');
const config = require('./config/config');

const routes = {
  products: require('./routes/products'),
  orders: require('./routes/orders'),
  auth: require('./routes/auth'),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, \`http://\${req.headers.host || 'localhost'}\`);
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
  server.listen(config.port, () => console.log(\`legacy-shop listening on \${config.port}\`));
}

module.exports = { server, routes };
`);
commit('2021-02-14T09:03:00', 'Add payment processing via VMS gateway');

// ---- 7. THE legacy workaround commit ------------------------------------
write('src/services/paymentService.js', `'use strict';
// Payment service - talks to the legacy VMS payment gateway.
//
// +----------------------------------------------------------------------+
// | DO NOT REMOVE the setTimeout retry block below.                      |
// | The legacy gateway (INC-2231) drops roughly 0.3% of requests and     |
// | only recovers them when we re-send after ~200ms. Two attempts to     |
// | replace this gateway were abandoned (2021, 2023). Any change here    |
// | MUST keep the retry behavior. See docs/architecture.md.              |
// +----------------------------------------------------------------------+

const config = require('../config/config');
const { createDatabase } = require('../db/database');

function createPaymentService(dbDir) {
  const db = createDatabase(dbDir);

  function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

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
      // DO NOT REMOVE - legacy VMS gateway retry workaround (INC-2231)
      await delay(config.gatewayLegacyRetryMs);
      ack = true; // after one retry the gateway always acks
    }
    return { ok: ack, txId: 'vms-' + Date.now() + '-' + Math.floor(Math.random() * 10000) };
  }

  return {
    async charge(orderId, amountCents) {
      if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('invalid_amount');
      const payments = db.read('payments', []);
      const result = await callGateway({ kind: 'charge', orderId, amountCents });
      payments.push({ orderId, amountCents, txId: result.txId, kind: 'charge' });
      db.write('payments', payments);
      return result;
    },
  };
}

module.exports = { createPaymentService };
`);
write('src/config/config.js', `'use strict';
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
`);
commit('2021-02-20T08:55:00', 'HACK: keep setTimeout retry in paymentService - required for legacy VMS gateway (INC-2231)');

// ---- 8. Refunds (the race) -----------------------------------------------
write('src/services/paymentService.js', fs.readFileSync(path.join(snapshot, 'src/services/paymentService.js')));
write('src/routes/orders.js', fs.readFileSync(path.join(snapshot, 'src/routes/orders.js')));
commit('2021-05-03T17:19:00', 'Add refund support (known race issue under concurrent refunds, see README)');

// ---- 9. Tests -------------------------------------------------------------
write('tests/products.test.js', fs.readFileSync(path.join(snapshot, 'tests/products.test.js')));
write('tests/auth.test.js', fs.readFileSync(path.join(snapshot, 'tests/auth.test.js')));
commit('2022-08-11T10:44:00', 'Add tests for products and auth');

write('tests/payment.test.js', fs.readFileSync(path.join(snapshot, 'tests/payment.test.js')));
write('tests/orders.test.js', fs.readFileSync(path.join(snapshot, 'tests/orders.test.js')));
commit('2023-01-09T12:31:00', 'Add payment and order tests; skip double-refund case (TODO)');

// ---- 10. Docs -------------------------------------------------------------
write('docs/architecture.md', fs.readFileSync(path.join(snapshot, 'docs/architecture.md')));
commit('2023-11-28T09:26:00', 'Document architecture: gateway situation, sync IO rationale, ID contract');

// ---- 11. Final state ------------------------------------------------------
write('README.md', fs.readFileSync(path.join(snapshot, 'README.md')));
write('package.json', fs.readFileSync(path.join(snapshot, 'package.json')));
write('src/app.js', fs.readFileSync(path.join(snapshot, 'src/app.js')));
write('src/routes/products.js', fs.readFileSync(path.join(snapshot, 'src/routes/products.js')));
commit('2024-06-14T15:08:00', 'Bump version to 1.4.2, refresh README conventions and warnings');

// verify working tree matches the snapshot exactly
fs.rmSync(snapshot, { recursive: true, force: true });
const status = sh('git status --porcelain');
if (status.trim() !== '') {
  console.error('UNEXPECTED DIRTY TREE:\n' + status);
  process.exit(1);
}
console.log(sh('git log --oneline'));
console.log('Sample repository rebuilt. HEAD: ' + sh('git rev-parse --short HEAD').trim());
