const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config();
const prisma = require('./lib/prisma');
try { require('./db'); } catch (e) {}

const serverPort = process.env.PORT || 5000;
const app = express();

// Global Middleware Setup
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Health Check Endpoint
app.get(['/health', '/api/health'], async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'OK', database: 'connected', timestamp: new Date() });
  } catch (error) {
    res.status(500).json({ status: 'error', database: 'disconnected', message: error.message });
  }
});

// API Routes
app.use('/api/categories', require('./routes/categories'));
app.use('/api/products', require('./routes/products'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/sales', require('./routes/sales'));
app.use('/api/vendors', require('./routes/vendors'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/purchases', require('./routes/purchases'));

// Phase 1 Routes: Company Profile & User/Role Permissions
app.use('/api/company', require('./routes/company'));
app.use('/api/users', require('./routes/users'));

// Phase 3 Route: Inventory Control, Expiry Alerts & Stock Adjustments
app.use('/api/inventory', require('./routes/inventory'));

// Phase 9 Route: Financial Accounts & Customer/Supplier Aging Ledgers
app.use('/api/accounts', require('./routes/accounts'));
app.use('/api/expenses', require('./routes/accounts'));

// Phase 10 Route: Supplier Claims & Expired Returns Manager
app.use('/api/claims', require('./routes/claims'));

// Phase 12 Route: HR & Payroll Management Module
app.use('/api/hr', require('./routes/hr'));

// Phase 13 Route: Fixed Assets Register, Depreciation & Net Worth Valuation
app.use('/api/assets', require('./routes/assets'));

// Digital Booking Orders & Customer/Booker Order Portal
app.use('/api/orders', require('./routes/orders'));

// Phase 14 Route: Offline-First Mobile & Tablet Database Synchronization
app.use('/api/sync', require('./routes/sync'));

// Serve static frontend build if present in ./public
const publicPath = path.join(__dirname, 'public');
if (fs.existsSync(publicPath)) {
  app.use(express.static(publicPath));

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path === '/health') {
      return next();
    }
    const cleanPath = req.path.replace(/^\//, '').replace(/\/$/, '');
    const specificHtml = path.join(publicPath, `${cleanPath}.html`);
    if (cleanPath && fs.existsSync(specificHtml)) {
      return res.sendFile(specificHtml);
    }
    const indexHtml = path.join(publicPath, 'index.html');
    if (fs.existsSync(indexHtml)) {
      return res.sendFile(indexHtml);
    }
    next();
  });
}

// 404 Route Handler
app.use((req, res, next) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global Error Handling Middleware
app.use((err, req, res, next) => {
  console.error('Unhandled Error:', err);
  const statusCode = err.statusCode || err.status || 500;
  res.status(statusCode).json({
    error: err.name || 'InternalServerError',
    message: err.message || 'An unexpected error occurred.',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// Server Initialization
async function startServer() {
  try {
    await prisma.$connect();
    console.log('✅ Connected to live PostgreSQL Database via Prisma Client.');
  } catch (error) {
    console.warn('⚠️ PostgreSQL connection failed:', error.message);
  }

  const server = app.listen(serverPort, '0.0.0.0', () => {
    console.log(`🚀 Express server running on http://0.0.0.0:${serverPort} (Accessible by Android Emulator at http://10.0.2.2:${serverPort})`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`⚠️ Port ${serverPort} is already in use by another process.`);
    } else {
      console.error('Server error:', err);
    }
  });
}

startServer();

// Graceful Shutdown Handlers
process.on('SIGINT', async () => {
  await prisma.$disconnect();
  console.log('Prisma client disconnected. Exiting...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  console.log('Prisma client disconnected. Exiting...');
  process.exit(0);
});

module.exports = app;
