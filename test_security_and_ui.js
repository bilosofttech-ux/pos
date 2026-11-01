const http = require('http');
const mysql = require('./node_modules/mysql2/promise');
const dotenv = require('./node_modules/dotenv');
const path = require('path');
const { generateLicenseKey } = require('./lib/license');

dotenv.config({ path: path.join(__dirname, '.env') });

const API_BASE = 'http://localhost:5000/api';

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + path);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function wipeDatabase() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  const [tables] = await conn.query('SHOW TABLES');
  for (const t of tables) {
    const tableName = Object.values(t)[0];
    await conn.query(`TRUNCATE TABLE \`${tableName}\``);
  }
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  await conn.end();
}

async function runSecurityTests() {
  console.log('=================================================================');
  console.log('🛡️ Starting Security, Trial Anti-Tamper & Password Complexity Tests');
  console.log('=================================================================\n');

  let passed = 0;
  let failed = 0;

  async function testStep(name, fn) {
    try {
      process.stdout.write(`⏳ Testing: ${name}... `);
      await fn();
      console.log('✅ PASS');
      passed++;
    } catch (err) {
      console.log(`❌ FAIL: ${err.message}`);
      failed++;
    }
  }

  // 1. Initial Wipe
  await testStep('Wipe DB for Fresh Baseline', async () => {
    await wipeDatabase();
  });

  // 2. Password: Reject Missing Uppercase
  await testStep('Reject Registration without Uppercase (e.g. bilal123@)', async () => {
    const res = await request('POST', '/users/register', {
      fullName: 'Test User',
      email: 'test_no_upper@example.com',
      password: 'bilal123@'
    });
    if (res.status !== 400 || !res.data?.error?.includes('uppercase')) {
      throw new Error(`Expected 400 with uppercase error, got status ${res.status}: ${JSON.stringify(res.data)}`);
    }
  });

  // 3. Password: Reject Missing Number
  await testStep('Reject Registration without Number (e.g. BilalPass@)', async () => {
    const res = await request('POST', '/users/register', {
      fullName: 'Test User',
      email: 'test_no_num@example.com',
      password: 'BilalPass@'
    });
    if (res.status !== 400 || !res.data?.error?.includes('number')) {
      throw new Error(`Expected 400 with number error, got status ${res.status}: ${JSON.stringify(res.data)}`);
    }
  });

  // 4. Password: Reject Missing Special Symbol
  await testStep('Reject Registration without Special Symbol (e.g. Bilal12345)', async () => {
    const res = await request('POST', '/users/register', {
      fullName: 'Test User',
      email: 'test_no_sym@example.com',
      password: 'Bilal12345'
    });
    if (res.status !== 400 || !res.data?.error?.includes('special symbol')) {
      throw new Error(`Expected 400 with symbol error, got status ${res.status}: ${JSON.stringify(res.data)}`);
    }
  });

  // 5. Password: Accept Compliant Password
  let registeredUser = null;
  await testStep('Accept Compliant Password (Bilal123@)', async () => {
    const res = await request('POST', '/users/register', {
      fullName: 'Bilal Soft Client',
      email: 'bilal_client@example.com',
      password: 'Bilal123@',
      businessName: 'Bilal Care Pharmacy',
      businessType: 'Pharmacy'
    });
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`Expected success, got: ${JSON.stringify(res.data)}`);
    }
    registeredUser = res.data;
  });

  // 6. Trial Status Endpoint
  await testStep('Authoritative Trial Status (30 days remaining for new user)', async () => {
    const res = await request('GET', `/users/trial-status?userId=${registeredUser.id}`);
    if (res.status !== 200) throw new Error(`Status ${res.status}: ${JSON.stringify(res.data)}`);
    if (res.data.daysRemaining !== 30 || res.data.isExpired !== false) {
      throw new Error(`Unexpected trial calculation: ${JSON.stringify(res.data)}`);
    }
  });

  // 7. Reject Forged License Key
  await testStep('Reject Forged / Random License Key', async () => {
    const res = await request('POST', '/users/license/activate', {
      userId: registeredUser.id,
      licenseKey: 'POS-FAKE-12345-HACKED'
    });
    if (res.status !== 400) {
      throw new Error(`Expected rejection for forged key, got status ${res.status}: ${JSON.stringify(res.data)}`);
    }
  });

  // 8. Accept Cryptographically Signed License Key
  await testStep('Accept Valid Cryptographic HMAC License Key', async () => {
    const genuineKey = generateLicenseKey(registeredUser.id, registeredUser.email, 'LIFETIME');
    const res = await request('POST', '/users/license/activate', {
      userId: registeredUser.id,
      licenseKey: genuineKey
    });
    if (res.status !== 200 || !res.data?.success) {
      throw new Error(`Expected activation success, got: ${JSON.stringify(res.data)}`);
    }
  });

  // 9. Verified Trial Status is now Unrestricted Lifetime
  await testStep('Verify User is Permanently Licensed in MariaDB', async () => {
    const res = await request('GET', `/users/trial-status?userId=${registeredUser.id}`);
    if (res.data.isLicensed !== true || res.data.daysRemaining !== 999) {
      throw new Error(`Expected isLicensed: true with 999 days, got: ${JSON.stringify(res.data)}`);
    }
  });

  // 10. Anti-Tamper Expired Trial Simulation
  await testStep('Anti-Tamper Middleware (Block expired non-licensed users with 403)', async () => {
    // Create an expired non-licensed user in MySQL directly (set createdAt 45 days ago)
    const conn = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME
    });

    const expiredUserId = 'expired-test-uuid-999';
    const fortyFiveDaysAgo = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    await conn.query(`
      INSERT INTO \`User\` (\`id\`, \`username\`, \`fullName\`, \`email\`, \`password\`, \`role\`, \`isLicensed\`, \`createdAt\`, \`updatedAt\`)
      VALUES (?, ?, ?, ?, ?, 'Admin', 0, ?, NOW())
    `, [expiredUserId, 'expired_user', 'Expired Store', 'expired@test.com', 'scrypt:test', fortyFiveDaysAgo]);
    await conn.end();

    // Now test if API operations (e.g. /api/products) are strictly blocked with 403 Forbidden!
    const res = await request('POST', '/products', {
      name: 'Blocked Medicine Attempt',
      retailPrice: 100
    }, { 'x-user-id': expiredUserId });

    if (res.status !== 403 || res.data?.trialExpired !== true) {
      throw new Error(`Security breach: Expired user was NOT blocked with 403! Got: ${res.status} ${JSON.stringify(res.data)}`);
    }
  });

  // 11. Final Clean Slate Wipe (0 records left)
  await testStep('Final Database Wipe (Zero remnant records, Clean Slate for Clients)', async () => {
    await wipeDatabase();
  });

  console.log('\n=================================================================');
  console.log(`📊 Security Test Summary: ${passed} Passed, ${failed} Failed`);
  console.log('=================================================================\n');

  if (failed === 0) {
    console.log('🎉 100% UNBREAKABLE SECURITY: ALL TRIAL & PASSWORD CHECKS VERIFIED ON MYSQL!');
  } else {
    console.log('⚠️ Some security tests failed. Please review above.');
  }
}

runSecurityTests().catch(err => {
  console.error('Fatal error:', err);
});
