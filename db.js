const mysql = require('mysql2/promise');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config();

let pool = null;

try {
  pool = mysql.createPool({
    host: process.env.DB_HOST || 'auth-db2133.hstgr.io',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'u132167659_bilalpos',
    password: process.env.DB_PASSWORD || 'Bilal11223344@',
    database: process.env.DB_NAME || 'u132167659_bilosoftech',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });
  console.log('[MySQL] Connection pool initialized for MariaDB / MySQL.');
} catch (err) {
  console.warn('[MySQL] Pool initialization notice:', err.message);
}

module.exports = pool;
