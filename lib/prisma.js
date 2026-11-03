const { PrismaClient } = require('@prisma/client');
const path = require('path');
const dotenv = require('dotenv');

// Ensure environment variables are loaded from all common paths
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });
dotenv.config();

function getDatabaseUrl() {
  let url = process.env.DATABASE_URL || '';
  if (url) {
    url = url.trim().replace(/^["']|["']$/g, '');
  }

  // If missing or invalid protocol, build guaranteed valid MySQL connection URL
  if (!url || (!url.startsWith('mysql://') && !url.startsWith('mariadb://'))) {
    const host = process.env.DB_HOST || 'auth-db2133.hstgr.io';
    const port = process.env.DB_PORT || '3306';
    const user = process.env.DB_USER || 'u132167659_bilalpos';
    const rawPass = process.env.DB_PASSWORD || 'Bilal11223344@';
    const password = encodeURIComponent(rawPass);
    const database = process.env.DB_NAME || 'u132167659_bilosoftech';
    url = `mysql://${user}:${password}@${host}:${port}/${database}?connection_limit=30&pool_timeout=60&connect_timeout=60`;
  }

  // Sync back to process.env so internal Prisma binaries also receive it
  process.env.DATABASE_URL = url;
  return url;
}

let _prismaInstance = null;

const BYPASS_PROPS = new Set(['setDatabasePath', 'getPrisma', '__esModule', 'then', 'catch', 'finally']);

/**
 * Maintained for backward compatibility with Electron lifecycle
 */
function setDatabasePath(userDataPath) {
  console.log('[DB] Live MariaDB / MySQL database initialized via environment configuration.');
}

function getPrisma() {
  if (_prismaInstance) return _prismaInstance;

  const dbUrl = getDatabaseUrl();

  _prismaInstance = new PrismaClient({
    datasources: {
      db: {
        url: dbUrl,
      },
    },
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

  console.log('[DB] PrismaClient initialized for MariaDB / MySQL.');
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
