const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// File-based persistence fallback for digital booking orders and portal pricing settings
const ordersFilePath = path.join(__dirname, '..', 'data', 'booking_orders.json');
const settingsFilePath = path.join(__dirname, '..', 'data', 'portal_settings.json');

// Helper to read orders
function readOrders() {
  try {
    if (!fs.existsSync(ordersFilePath)) {
      const dir = path.dirname(ordersFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(ordersFilePath, JSON.stringify([]));
      return [];
    }
    const data = fs.readFileSync(ordersFilePath, 'utf8');
    return JSON.parse(data || '[]');
  } catch (err) {
    console.error('Error reading booking orders:', err);
    return [];
  }
}

// Helper to write orders
function writeOrders(orders) {
  try {
    const dir = path.dirname(ordersFilePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ordersFilePath, JSON.stringify(orders, null, 2));
  } catch (err) {
    console.error('Error writing booking orders:', err);
  }
}

// Helper to read portal pricing settings
function readPortalSettings() {
  try {
    if (!fs.existsSync(settingsFilePath)) {
      const defaultSettings = {
        showPrices: false,
        pricingMode: 'standard', // 'standard' | 'discount' | 'custom'
        flatDiscountPercent: 0,
        customPrices: {}
      };
      const dir = path.dirname(settingsFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(settingsFilePath, JSON.stringify(defaultSettings, null, 2));
      return defaultSettings;
    }
    const data = fs.readFileSync(settingsFilePath, 'utf8');
    return JSON.parse(data || '{}');
  } catch (err) {
    return { showPrices: false, pricingMode: 'standard', flatDiscountPercent: 0, customPrices: {} };
  }
}

function writePortalSettings(settings) {
  try {
    const dir = path.dirname(settingsFilePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(settingsFilePath, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('Error saving portal settings:', err);
  }
}

// GET /api/orders/settings - Fetch customer portal pricing configuration
router.get('/settings', (req, res) => {
  try {
    const settings = readPortalSettings();
    res.json(settings);
  } catch (error) {
    console.error('Error fetching portal settings:', error);
    res.status(500).json({ error: 'Failed to fetch portal settings' });
  }
});

// POST /api/orders/settings - Save customer portal pricing configuration
router.post('/settings', (req, res) => {
  try {
    const current = readPortalSettings();
    const updated = {
      ...current,
      ...req.body,
      updatedAt: new Date().toISOString()
    };
    writePortalSettings(updated);
    res.json({ success: true, settings: updated });
  } catch (error) {
    console.error('Error updating portal settings:', error);
    res.status(500).json({ error: 'Failed to update portal settings' });
  }
});

// GET /api/orders - Fetch all booking orders with optional status filter
router.get('/', (req, res) => {
  try {
    const { status } = req.query;
    const orders = readOrders();
    const filtered = status && status !== 'ALL'
      ? orders.filter(o => o.status === status)
      : orders;
    res.json(filtered.reverse());
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// GET /api/orders/pending-count - Fetch count of pending orders for real-time notification
router.get('/pending-count', (req, res) => {
  try {
    const orders = readOrders();
    const pending = orders.filter(o => o.status === 'PENDING');
    res.json({ count: pending.length, latestOrder: pending[pending.length - 1] || null });
  } catch (error) {
    console.error('Error fetching pending order count:', error);
    res.status(500).json({ count: 0 });
  }
});

// POST /api/orders - Submit a new Digital Booking Order from Booker / Customer
router.post('/', (req, res) => {
  try {
    const {
      customerName,
      customerPhone,
      customerAddress,
      bookerName,
      notes,
      items
    } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Order must contain at least one item' });
    }

    const orders = readOrders();
    const orderNo = `ORD-${Date.now().toString().slice(-6)}`;

    let totalAmount = 0;
    let totalQty = 0;

    const validatedItems = items.map((it) => {
      const qty = parseInt(it.quantity || 1, 10);
      const stp = parseFloat(it.stp || 0);
      const net = qty * stp;
      totalAmount += net;
      totalQty += qty;

      return {
        productId: it.productId || '',
        productCode: it.productCode || '',
        productName: it.productName || it.name || 'Medicine Item',
        genericName: it.genericName || '',
        packSize: it.packSize || it.unit || 'Box',
        unit: it.unit || 'Box',
        quantity: qty,
        stp: stp,
        netAmount: net,
      };
    });

    const newOrder = {
      id: `ord_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      orderNo,
      customerName: customerName ? customerName.trim() : 'Market Booker Customer',
      customerPhone: customerPhone ? customerPhone.trim() : '',
      customerAddress: customerAddress ? customerAddress.trim() : '',
      bookerName: bookerName ? bookerName.trim() : 'Direct Order',
      notes: notes ? notes.trim() : '',
      status: 'PENDING', // 'PENDING' | 'BILLED' | 'CANCELLED'
      items: validatedItems,
      totalItems: validatedItems.length,
      totalQty,
      totalAmount,
      createdAt: new Date().toISOString(),
      billedAt: null,
      invoiceNo: null,
    };

    orders.push(newOrder);
    writeOrders(orders);

    res.status(201).json({
      success: true,
      message: `Order #${orderNo} placed successfully!`,
      order: newOrder
    });
  } catch (error) {
    console.error('Error placing booking order:', error);
    res.status(500).json({ error: 'Failed to place booking order' });
  }
});

const updateOrderStatusHandler = (req, res) => {
  try {
    const { id } = req.params;
    const { status, invoiceNo } = req.body;
    const orders = readOrders();
    const idx = orders.findIndex(o => o.id === id || o.orderNo === id);

    if (idx === -1) {
      return res.status(404).json({ error: 'Order not found' });
    }

    orders[idx].status = status || orders[idx].status;
    if (status === 'BILLED') {
      orders[idx].billedAt = new Date().toISOString();
      if (invoiceNo) orders[idx].invoiceNo = invoiceNo;
    }

    writeOrders(orders);
    res.json({ success: true, order: orders[idx] });
  } catch (error) {
    console.error('Error updating order status:', error);
    res.status(500).json({ error: 'Failed to update order status' });
  }
};

// PATCH & POST /api/orders/:id/status - Update Order Status (e.g. BILLED or CANCELLED)
router.patch('/:id/status', updateOrderStatusHandler);
router.post('/:id/status', updateOrderStatusHandler);

// DELETE /api/orders/:id - Delete / Cancel order
router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;
    let orders = readOrders();
    orders = orders.filter(o => o.id !== id && o.orderNo !== id);
    writeOrders(orders);
    res.json({ success: true, message: 'Order removed' });
  } catch (error) {
    console.error('Error deleting order:', error);
    res.status(500).json({ error: 'Failed to delete order' });
  }
});

module.exports = router;
