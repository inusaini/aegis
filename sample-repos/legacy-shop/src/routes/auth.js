'use strict';
// Auth routes.

const config = require('../config/config');
const { createAuthService } = require('../services/authService');
const { issueToken } = require('../lib/tokens');

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function service() {
  return createAuthService(config.dbDir);
}

module.exports = {
  async register(req, res, body) {
    try {
      const user = service().register(body || {});
      json(res, 201, { user, token: issueToken(user.id) });
    } catch (err) {
      if (err.message === 'duplicate_user') return json(res, 409, { error: err.message });
      json(res, 400, { error: err.message });
    }
  },

  async login(req, res, body) {
    try {
      const user = service().login(body || {});
      json(res, 200, { user, token: issueToken(user.id) });
    } catch (err) {
      json(res, 401, { error: err.message });
    }
  },
};
