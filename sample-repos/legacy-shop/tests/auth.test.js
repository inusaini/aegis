'use strict';
// Auth service tests.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createAuthService } = require('../src/services/authService');
const { issueToken, verifyToken } = require('../src/lib/tokens');

function makeTempDbDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-shop-auth-'));
}

test('register creates a member user', () => {
  const svc = createAuthService(makeTempDbDir());
  const user = svc.register({ email: 'a@example.com', password: 'pw12345' });
  assert.strictEqual(user.role, 'member');
  assert.ok(user.id >= 1);
});

test('register rejects duplicate email', () => {
  const svc = createAuthService(makeTempDbDir());
  svc.register({ email: 'a@example.com', password: 'pw12345' });
  assert.throws(() => svc.register({ email: 'a@example.com', password: 'x' }), /duplicate_user/);
});

test('login with wrong password fails', () => {
  const svc = createAuthService(makeTempDbDir());
  svc.register({ email: 'a@example.com', password: 'pw12345' });
  assert.throws(() => svc.login({ email: 'a@example.com', password: 'wrong' }), /invalid_credentials/);
});

test('tokens round-trip user id', () => {
  const token = issueToken(42);
  const payload = verifyToken(token);
  assert.strictEqual(payload.userId, 42);
});

test('garbage token rejected', () => {
  assert.strictEqual(verifyToken('not.a.token'), null);
});
