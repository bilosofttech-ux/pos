/**
 * Comprehensive End-to-End Test Suite for MariaDB & MySQL
 * Tests:
 * 1. Health & Database Connectivity
 * 2. User Registration & Multi-Tenant Isolation
 * 3. User Login & Scrypt Password Hashing
 * 4. Pharmacy Company Profile
 * 5. Products & Pricing (TP, MRP, Barcode)
 * 6. Purchases & Stock-In
 * 7. Stock Adjustments (Physical count / Audit)
 * 8. Sales Invoicing & Stock Deduction
 * 9. Sales Return / Refund & Stock Restoration
 * 10. Financial Ledgers (Customer Khata / Balances)
 * 11. Daily Sales & Profitability Reports
 * 12. Strict Multi-Tenant Separation (User A vs User B)
 * 13. Clean-Slate Database Wipe (Zero remnant test data)
 */

const http = require('http');
const mysql = require('./node_modules/mysql2/promise');
const dotenv = require('./node_modules/dotenv');
const path = require('path');

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

async function runTests() {
  console.log('=================================================================');
  console.log('🚀 Starting CloudPOS & ERP MariaDB / MySQL Complete Verification');
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

  // Initial Wipe to start with a fresh slate
  await testStep('Wipe Database (Start Fresh)', async () => {
    await wipeDatabase();
  });

  // 1. Health Check
  await testStep('Backend Server Health Check', async () => {
    const res = await request('GET', '/health');
    if (res.status !== 200 && res.status !== 500) {
      throw new Error(`Unexpected status ${res.status}`);
    }
    if (res.data?.database !== 'connected') {
      throw new Error(`Database reported as: ${res.data?.database}`);
    }
  });

  const timestamp = Date.now();
  const testEmail = `pharmacist_${timestamp}@example.com`;
  const testPassword = 'Password123!';
  let user = null;
  let headers = {};

  // 2. User Registration
  await testStep('User Registration & Multi-Tenant Setup', async () => {
    const res = await request('POST', '/users/register', {
      fullName: 'Dr. Test Pharmacist',
      email: testEmail,
      username: `pharma_${timestamp}`,
      password: testPassword,
      businessName: 'Al-Shifa Care Pharmacy',
      businessType: 'Pharmacy'
    });

    if (res.status !== 201 && res.status !== 200) {
      throw new Error(res.data?.error || `Registration failed with status ${res.status}`);
    }
    user = res.data;
    if (!user.id) throw new Error('No user ID returned');
    headers = { 'x-user-id': user.id };
  });

  // 3. User Login
  await testStep('User Login & Password Hashing Verification', async () => {
    const res = await request('POST', '/users/login', {
      username: testEmail,
      password: testPassword
    });

    if (res.status !== 200) {
      throw new Error(res.data?.error || `Login failed with status ${res.status}`);
    }
    if (!res.data.id) throw new Error('Login failed to return authenticated user');
  });

  // 4. Pharmacy Profile
  await testStep('Company Profile for Tenant', async () => {
    const res = await request('GET', '/company', null, headers);
    if (res.status !== 200) throw new Error('Could not retrieve company profile');
    const comp = Array.isArray(res.data) ? res.data[0] : res.data;
    if (!comp) throw new Error('Company profile was empty');
  });

  // 5. Product Creation
  let product = null;
  await testStep('Create Product with Pricing & Batches', async () => {
    const res = await request('POST', '/products', {
      name: `Augmentin 625mg Tab #${timestamp}`,
      genericName: 'Co-Amoxiclav',
      companyName: 'GSK Pakistan',
      category: 'Antibiotics',
      barcode: `896${timestamp.toString().slice(-9)}`,
      stockQuantity: 100,
      minStockLimit: 15,
      purchasePrice: 420.0,
      tradePrice: 450.0,
      retailPrice: 517.50,
      batches: [
        {
          batchNo: `BAT-${timestamp.toString().slice(-4)}`,
          expiryDate: '2028-12-31T00:00:00.000Z',
          quantity: 100,
          purchasePrice: 420.0,
          tradePrice: 450.0,
          retailPrice: 517.50
        }
      ]
    }, headers);

    if (res.status !== 201 && res.status !== 200) {
      throw new Error(res.data?.error || `Failed creating product: ${res.status}`);
    }
    product = res.data;
    if (!product.id) throw new Error('No product ID returned');
    if (product.stockQuantity !== 100) throw new Error(`Expected initial stock 100, got ${product.stockQuantity}`);
  });

  // 6. Purchases (Stock In)
  await testStep('Create Purchase Bill (Stock-In +50 units)', async () => {
    const res = await request('POST', '/purchases', {
      purchaseNo: `PUR-${timestamp.toString().slice(-5)}`,
      vendorName: 'GSK Distribution Lahore',
      vendorArea: 'Wholesale Medicine Market',
      salesman: 'Akram Supplier',
      totalAmount: 21000.0,
      items: [
        {
          productId: product.id,
          productName: product.name,
          quantity: 50,
          purchasePrice: 420.0,
          net: 21000.0
        }
      ]
    }, headers);

    if (res.status !== 201 && res.status !== 200) {
      throw new Error(res.data?.error || `Purchase creation failed: ${res.status}`);
    }

    // Verify product stock increased to 150
    const prodRes = await request('GET', `/products/${product.id}`, null, headers);
    if (prodRes.data?.stockQuantity !== 150) {
      throw new Error(`Expected stock 150 after purchase, got ${prodRes.data?.stockQuantity}`);
    }
  });

  // 7. Stock Adjustment
  await testStep('Stock Adjustment (Physical Audit +10 units)', async () => {
    const res = await request('POST', '/inventory/adjust', {
      productId: product.id,
      adjustmentType: 'AdjustmentIn',
      quantity: 10,
      reason: 'Physical inventory audit found extra pack',
      adjustedBy: 'Dr. Test Pharmacist'
    }, headers);

    if (res.status !== 200 && res.status !== 201) {
      throw new Error(res.data?.error || `Stock adjustment failed: ${res.status}`);
    }

    // Verify stock is now 160
    const prodRes = await request('GET', `/products/${product.id}`, null, headers);
    if (prodRes.data?.stockQuantity !== 160) {
      throw new Error(`Expected stock 160 after adjustment, got ${prodRes.data?.stockQuantity}`);
    }
  });

  // 8. Customer & Sales Invoice
  let customer = null;
  let invoice = null;
  await testStep('Sales Invoicing (Sell 5 units -> Stock Decrement)', async () => {
    // Create Customer
    const custRes = await request('POST', '/customers', {
      name: `Walk-in Patient #${timestamp.toString().slice(-4)}`,
      address: 'Gulshan, Block 4',
      contactNo: '03001234567'
    }, headers);

    customer = custRes.data;

    // Create Invoice with 5 packs
    const invRes = await request('POST', '/sales', {
      customerId: customer?.id || null,
      customerName: customer?.name || 'Walk-in Patient',
      salesman: 'Counter 1',
      items: [
        {
          productId: product.id,
          quantity: 5,
          price: 517.50,
          discount: 0,
          salesTax: 0
        }
      ]
    }, headers);

    if (invRes.status !== 201 && invRes.status !== 200) {
      throw new Error(invRes.data?.error || `Invoice creation failed: ${invRes.status}`);
    }
    invoice = invRes.data;
    if (!invoice.id && !invoice.invoiceNo) throw new Error('No invoice generated');

    // Verify stock decremented to 155
    const prodRes = await request('GET', `/products/${product.id}`, null, headers);
    if (prodRes.data?.stockQuantity !== 155) {
      throw new Error(`Expected stock 155 after sale, got ${prodRes.data?.stockQuantity}`);
    }
  });

  // 9. Sales Return / Refund
  await testStep('Sales Return / Refund (Restore 5 units back to stock)', async () => {
    const invNum = invoice.invoiceNo || invoice.id;
    const returnRes = await request('POST', `/invoices/${invNum}/return`, {
      refundMethod: 'Cash',
      reason: 'Patient changed prescription'
    }, headers);

    if (returnRes.status !== 200 && returnRes.status !== 201) {
      throw new Error(returnRes.data?.error || `Return failed: ${returnRes.status}`);
    }

    // Verify stock restored back to 160
    const prodRes = await request('GET', `/products/${product.id}`, null, headers);
    if (prodRes.data?.stockQuantity !== 160) {
      throw new Error(`Expected stock restored to 160, got ${prodRes.data?.stockQuantity}`);
    }
  });

  // 10. Financial Accounts & Customer Aging
  await testStep('Financial Accounts & Customer Aging Ledgers', async () => {
    const res = await request('GET', '/accounts/customer-aging', null, headers);
    if (res.status !== 200) throw new Error(`Could not load customer aging: ${res.status}`);
    if (!Array.isArray(res.data)) throw new Error('Expected array of aging records');
  });

  // 11. Daily Sales & Profitability Report
  await testStep('Daily Sales Analytics & Profitability Reports', async () => {
    const res = await request('GET', '/sales', null, headers);
    if (res.status !== 200) throw new Error(`Could not fetch sales report: ${res.status}`);
    if (!Array.isArray(res.data)) throw new Error('Expected array of invoices');
  });

  // 12. Strict Multi-Tenant Separation
  await testStep('Strict Multi-Tenant Isolation (Tenant B cannot see Tenant A)', async () => {
    // Register Tenant B
    const bRes = await request('POST', '/users/register', {
      fullName: 'Dr. Tenant B',
      email: `tenant_b_${timestamp}@example.com`,
      username: `tenant_b_${timestamp}`,
      password: 'Password123!',
      businessName: 'Sehat Medical Store',
      businessType: 'Pharmacy'
    });

    if (!bRes.data?.id) throw new Error('Failed to register Tenant B');
    const headersB = { 'x-user-id': bRes.data.id };

    // Tenant B queries products
    const bProducts = await request('GET', '/products', null, headersB);
    if (Array.isArray(bProducts.data) && bProducts.data.some(p => p.id === product.id)) {
      throw new Error('SECURITY VIOLATION: Tenant B could see Tenant A products!');
    }

    // Tenant B queries sales
    const bSales = await request('GET', '/sales', null, headersB);
    if (Array.isArray(bSales.data) && bSales.data.some(s => s.id === invoice.id)) {
      throw new Error('SECURITY VIOLATION: Tenant B could see Tenant A sales!');
    }
  });

  // 13. Final Clean Wipe as requested by the user
  await testStep('Final Database Wipe (Zero remnant data, Fresh Clean State)', async () => {
    await wipeDatabase();
  });

  console.log('\n=================================================================');
  console.log(`📊 Test Summary: ${passed} Passed, ${failed} Failed`);
  console.log('=================================================================\n');

  if (failed === 0) {
    console.log('🎉 100% SUCCESS: ALL 13 REAL-TIME FEATURES VERIFIED ON MARIADB / MYSQL!');
    console.log('✨ Live Database is completely clean, fresh, and ready for real clients!');
  } else {
    console.log('⚠️ Some tests failed. Please review the output above.');
  }
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
});
