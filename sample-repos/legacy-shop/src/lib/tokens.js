'use strict';
// Token helpers for the hand-rolled auth (no JWT — 2015 constraint).

const crypto = require('crypto');
const config = require('../config/config');

function issueToken(userId) {
  const payload = `${userId}.${Date.now()}`;
  const sig = crypto.createHmac('sha256', config.tokenSecret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, ts, sig] = parts;
  const expected = crypto.createHmac('sha256', config.tokenSecret).update(`${userId}.${ts}`).digest('hex');
  if (sig !== expected) return null;
  return { userId: Number(userId) };
}

module.exports = { issueToken, verifyToken };
