'use strict';
// Authentication service. Email + token, no passwords in the 2015 system —
// the frontend "logged in" via a magic link. Passwords arrived in 2019 and
// live in the same table now.

const crypto = require('crypto');
const { createDatabase } = require('../db/database');
const { nextId } = require('../lib/legacyIds');

function createAuthService(dbDir) {
  const db = createDatabase(dbDir);

  function hashPassword(pw) {
    return crypto.createHash('sha256').update(String(pw)).digest('hex');
  }

  return {
    register({ email, name, password, role }) {
      if (!email || !email.includes('@')) throw new Error('invalid_email');
      const users = db.read('users', []);
      if (users.some((u) => u.email === email)) throw new Error('duplicate_user');
      const user = {
        id: nextId(),
        email,
        name: name || email.split('@')[0],
        passwordHash: hashPassword(password || ''),
        role: role === 'admin' ? 'admin' : 'member',
      };
      users.push(user);
      db.write('users', users);
      return { id: user.id, email: user.email, name: user.name, role: user.role };
    },

    login({ email, password }) {
      const users = db.read('users', []);
      const user = users.find((u) => u.email === email);
      if (!user) throw new Error('invalid_credentials');
      const attempt = hashPassword(password || '');
      if (attempt !== user.passwordHash) throw new Error('invalid_credentials');
      return { id: user.id, email: user.email, role: user.role };
    },
  };
}

module.exports = { createAuthService };
