const { PrismaClient } = require('@prisma/client');
const path = require('path');
const dotenv = require('dotenv');

// Ensure environment variables are loaded
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
dotenv.config();

let _prismaInstance = null;

const BYPASS_PROPS = new Set(['setDatabasePath', 'getPrisma', '__esModule', 'then', 'catch', 'finally']);

/**
 * Maintained for backward compatibility with Electron lifecycle
 */
function setDatabasePath(userDataPath) {
  console.log('[DB] Live PostgreSQL database initialized via environment configuration.');
}

function getPrisma() {
  if (_prismaInstance) return _prismaInstance;

  _prismaInstance = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

  console.log('[DB] PrismaClient initialized for live PostgreSQL.');
  return _prismaInstance;
}

/**
 * Lazy proxy to expose PrismaClient methods and models
 */
const prismaProxy = new Proxy({}, {
  get(target, prop) {
    if (prop === 'setDatabasePath') return setDatabasePath;
    if (prop === 'getPrisma') return getPrisma;
    if (BYPASS_PROPS.has(prop)) return undefined;

    const instance = getPrisma();
    const value = instance[prop];
    if (typeof value === 'function') return value.bind(instance);
    return value;
  },
});

module.exports = prismaProxy;
