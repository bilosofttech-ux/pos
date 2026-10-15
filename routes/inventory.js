const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');

// GET /api/inventory/alerts - Retrieve Expiry & Stock Level Alerts
router.get('/alerts', async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      include: { vendor: true },
      orderBy: { name: 'asc' },
    });

    const now = new Date();
    const in30Days = new Date();
    in30Days.setDate(now.getDate() + 30);

    const in60Days = new Date();
    in60Days.setDate(now.getDate() + 60);

    const expired = [];
    const nearExpiry30 = [];
    const nearExpiry60 = [];
    const outOfStock = [];
    const lowStock = [];

    products.forEach((p) => {
      // Check Expiry Date
      if (p.expiryDate) {
        const exp = new Date(p.expiryDate);
        if (exp < now) {
          expired.push(p);
        } else if (exp <= in30Days) {
          nearExpiry30.push(p);
        } else if (exp <= in60Days) {
          nearExpiry60.push(p);
        }
      }

      // Check Stock Levels
      if (p.stockQuantity <= 0) {
        outOfStock.push(p);
      } else if (p.stockQuantity <= (p.minStock || 10)) {
        lowStock.push(p);
      }
    });

    res.json({
      counts: {
        expiredCount: expired.length,
        nearExpiry30Count: nearExpiry30.length,
        nearExpiry60Count: nearExpiry60.length,
        outOfStockCount: outOfStock.length,
        lowStockCount: lowStock.length,
        totalProducts: products.length,
      },
      expired,
      nearExpiry30,
      nearExpiry60,
      outOfStock,
      lowStock,
    });
  } catch (error) {
    console.error('Error fetching inventory alerts:', error);
    res.status(500).json({ error: 'Failed to fetch inventory alerts' });
  }
});

// GET /api/inventory/valuation - Total Stock Financial Valuation
router.get('/valuation', async (req, res) => {
  try {
    const products = await prisma.product.findMany();

    let totalCostValuation = 0;
    let totalRetailValuation = 0;
    let totalTradeValuation = 0;
    let totalStockUnits = 0;

    products.forEach((p) => {
      const qty = p.stockQuantity || 0;
      totalStockUnits += qty;
      totalCostValuation += qty * (p.costPrice || p.purchasePrice || 0);
      totalTradeValuation += qty * (p.tradePrice || 0);
      totalRetailValuation += qty * (p.retailPrice || 0);
    });

    res.json({
      totalStockUnits,
      totalCostValuation,
      totalTradeValuation,
      totalRetailValuation,
      estimatedProfitMargin: totalRetailValuation - totalCostValuation,
    });
  } catch (error) {
    console.error('Error calculating stock valuation:', error);
    res.status(500).json({ error: 'Failed to calculate inventory valuation' });
  }
});

// GET /api/inventory/adjustments - History log of stock adjustments
router.get('/adjustments', async (req, res) => {
  try {
    const logs = await prisma.stockAdjustment.findMany({
      include: { product: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json(logs);
  } catch (error) {
    console.error('Error fetching stock adjustments:', error);
    res.status(500).json({ error: 'Failed to fetch stock adjustments' });
  }
});

// POST /api/inventory/adjust - Execute stock adjustment / return / damaged log
router.post('/adjust', async (req, res) => {
  try {
    const { productId, adjustmentType, quantity, reason, adjustedBy } = req.body;

    if (!productId || !adjustmentType || quantity === undefined) {
      return res.status(400).json({ error: 'productId, adjustmentType, and quantity are required' });
    }

    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const qtyNumber = parseInt(quantity, 10);
    const previousStock = product.stockQuantity;
    let newStock = previousStock;

    // Calculate new stock based on adjustment type
    if (['Damaged', 'Expired', 'Return', 'AdjustmentOut'].includes(adjustmentType)) {
      newStock = Math.max(0, previousStock - qtyNumber);
    } else if (['PhysicalCount'].includes(adjustmentType)) {
      newStock = qtyNumber; // Set exact counted stock
    } else if (['AdjustmentIn'].includes(adjustmentType)) {
      newStock = previousStock + qtyNumber;
    }

    // Execute transaction: update product stock and create adjustment log
    const [updatedProduct, adjustmentLog] = await prisma.$transaction([
      prisma.product.update({
        where: { id: productId },
        data: { stockQuantity: newStock },
      }),
      prisma.stockAdjustment.create({
        data: {
          productId,
          adjustmentType,
          quantity: qtyNumber,
          previousStock,
          newStock,
          reason: reason || `Manual ${adjustmentType} adjustment`,
          adjustedBy: adjustedBy || 'Admin',
        },
        include: { product: true },
      }),
    ]);

    res.status(201).json({
      product: updatedProduct,
      log: adjustmentLog,
    });
  } catch (error) {
    console.error('Error executing stock adjustment:', error);
    res.status(500).json({ error: 'Failed to adjust inventory stock' });
  }
});

// GET /api/inventory/expiry-analysis - Batch Expiry Financial Risk Analysis & Timeline
router.get('/expiry-analysis', async (req, res) => {
  try {
    const { company } = req.query;
    const where = {};
    if (company && company !== 'ALL' && company !== 'All Companies') {
      where.companyName = { contains: company, mode: 'insensitive' };
    }

    const products = await prisma.product.findMany({
      where,
      include: { vendor: true },
      orderBy: { expiryDate: 'asc' },
    });

    const now = new Date();

    const expiredList = [];
    const critical30List = [];
    const warning60List = [];
    const watch90List = [];
    const months4List = [];
    const months6List = [];
    const months8List = [];
    const months12List = [];
    const quarantinedList = [];
    const noExpiryList = [];

    let expiredValue = 0;
    let critical30Value = 0;
    let warning60Value = 0;
    let watch90Value = 0;
    let months4Value = 0;
    let months6Value = 0;
    let months8Value = 0;
    let months12Value = 0;
    let quarantinedValue = 0;

    products.forEach((p) => {
      const stock = Number(p.stockQuantity !== undefined ? p.stockQuantity : (p.stock || 0));
      // Strictly ignore items with 0 stock (only include negative stock < 0 and positive stock > 0)
      if (stock === 0) return;

      const cost = p.costPrice || p.tradePrice || p.purchasePrice || (p.retailPrice ? p.retailPrice * 0.75 : 120);
      const val = cost * stock;

      if (p.isQuarantined) {
        quarantinedList.push(p);
        quarantinedValue += val;
      }

      let expDateObj = null;
      if (p.expiryDate) {
        const parsed = new Date(p.expiryDate);
        if (!isNaN(parsed.getTime())) {
          expDateObj = parsed;
        }
      }

      if (!expDateObj) {
        // Expiry date missing or not specified
        const enriched = {
          ...p,
          daysLeft: null,
          formattedExpiry: 'Expiry Not Mentioned',
          noExpiryMentioned: true,
          companyName: p.companyName || (p.vendor ? p.vendor.name : 'General Distributor'),
        };
        noExpiryList.push(enriched);
      } else {
        const daysLeft = Math.ceil((expDateObj - now) / (1000 * 60 * 60 * 24));
        const enriched = {
          ...p,
          daysLeft,
          formattedExpiry: expDateObj.toISOString().split('T')[0],
          companyName: p.companyName || (p.vendor ? p.vendor.name : 'General Distributor'),
        };

        if (expDateObj < now || daysLeft <= 0) {
          expiredList.push(enriched);
          expiredValue += val;
        } else {
          if (daysLeft <= 30) {
            critical30List.push(enriched);
            critical30Value += val;
          }
          if (daysLeft <= 60) {
            warning60List.push(enriched);
            warning60Value += val;
          }
          if (daysLeft <= 90) {
            watch90List.push(enriched);
            watch90Value += val;
          }
          if (daysLeft <= 120) {
            months4List.push(enriched);
            months4Value += val;
          }
          if (daysLeft <= 180) {
            months6List.push(enriched);
            months6Value += val;
          }
          if (daysLeft <= 240) {
            months8List.push(enriched);
            months8Value += val;
          }
          if (daysLeft <= 365) {
            months12List.push(enriched);
            months12Value += val;
          }
        }
      }
    });

    res.json({
      summary: {
        expiredCount: expiredList.length,
        expiredValue,
        critical30Count: critical30List.length,
        critical30Value,
        warning60Count: warning60List.length,
        warning60Value,
        watch90Count: watch90List.length,
        watch90Value,
        months4Count: months4List.length,
        months4Value,
        months6Count: months6List.length,
        months6Value,
        months8Count: months8List.length,
        months8Value,
        months12Count: months12List.length,
        months12Value,
        quarantinedCount: quarantinedList.length,
        quarantinedValue,
        noExpiryCount: noExpiryList.length,
        totalAtRiskValue: expiredValue + critical30Value + warning60Value + watch90Value,
      },
      expiredList,
      critical30List,
      warning60List,
      watch90List,
      months4List,
      months6List,
      months8List,
      months12List,
      quarantinedList,
      noExpiryList,
    });
  } catch (error) {
    console.error('Error fetching expiry analysis:', error);
    res.status(500).json({ error: 'Failed to generate batch expiry analysis' });
  }
});

// POST /api/inventory/quarantine - Lock / Release product batch quarantine status
router.post('/quarantine', async (req, res) => {
  try {
    const { productId, isQuarantined, quarantineReason, updatedBy } = req.body;

    if (!productId) {
      return res.status(400).json({ error: 'productId is required' });
    }

    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const updated = await prisma.product.update({
      where: { id: productId },
      data: {
        isQuarantined: Boolean(isQuarantined),
        quarantineReason: isQuarantined ? (quarantineReason || 'Safety Recall / Quality Lock') : null,
      },
      include: { vendor: true },
    });

    // Log adjustment entry for audit trail
    await prisma.stockAdjustment.create({
      data: {
        productId,
        adjustmentType: isQuarantined ? 'QuarantineLock' : 'QuarantineRelease',
        quantity: product.stockQuantity,
        previousStock: product.stockQuantity,
        newStock: product.stockQuantity,
        reason: isQuarantined ? `Quarantined: ${quarantineReason || 'Recall'}` : 'Released from Quarantine',
        adjustedBy: updatedBy || 'Admin',
      },
    });

    res.json({
      message: `Product ${isQuarantined ? 'Quarantined' : 'Released'} successfully`,
      product: updated,
    });
  } catch (error) {
    console.error('Error toggling quarantine status:', error);
    res.status(500).json({ error: 'Failed to update quarantine status' });
  }
});

// Market Purchase Requisitions Persistence Helpers
const fs = require('fs');
const path = require('path');
const reqFilePath = path.join(__dirname, '..', 'data', 'market_requisitions.json');

function readMarketReqs() {
  try {
    if (!fs.existsSync(reqFilePath)) {
      const dir = path.dirname(reqFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(reqFilePath, JSON.stringify([]));
      return [];
    }
    const data = fs.readFileSync(reqFilePath, 'utf8');
    return JSON.parse(data || '[]');
  } catch (e) {
    return [];
  }
}

function writeMarketReqs(list) {
  try {
    const dir = path.dirname(reqFilePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(reqFilePath, JSON.stringify(list, null, 2));
  } catch (e) {
    console.error('Error writing market requisitions:', e);
  }
}

// GET /api/inventory/market-requisitions - Fetch market purchase requisitions
router.get('/market-requisitions', (req, res) => {
  try {
    const list = readMarketReqs();
    res.json(list.reverse());
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch requisitions' });
  }
});

// POST /api/inventory/market-requisitions - Purchaser submits market purchase list
router.post('/market-requisitions', (req, res) => {
  try {
    const { purchaserName, notes, items } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Requisition must contain at least one purchased item' });
    }

    const list = readMarketReqs();
    const reqNo = `REQ-${Date.now().toString().slice(-6)}`;
    let totalAmount = 0;
    let totalQty = 0;

    const validatedItems = items.map((it) => {
      const qty = parseInt(it.quantity || 1, 10);
      const rate = parseFloat(it.purchaseRate || it.rate || 0);
      const subtotal = qty * rate;
      totalAmount += subtotal;
      totalQty += qty;

      return {
        productId: it.productId || '',
        productCode: it.productCode || '',
        productName: it.productName || it.name || 'Medicine Item',
        genericName: it.genericName || '',
        packSize: it.packSize || it.unit || 'Box',
        unit: it.unit || 'Box',
        quantity: qty,
        purchaseRate: rate,
        lastPurchaseDate: it.lastPurchaseDate || new Date().toISOString(),
        lastPurchaseRate: it.lastPurchaseRate || rate,
        netAmount: subtotal,
      };
    });

    const newReq = {
      id: `req_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      reqNo,
      purchaserName: purchaserName ? purchaserName.trim() : 'Market Purchaser',
      notes: notes ? notes.trim() : 'Purchased from Wholesale Market',
      status: 'IN_TRANSIT', // 'IN_TRANSIT' | 'RECEIVED' | 'CANCELLED'
      items: validatedItems,
      totalItems: validatedItems.length,
      totalQty,
      totalAmount,
      createdAt: new Date().toISOString(),
      receivedAt: null,
    };

    list.push(newReq);
    writeMarketReqs(list);

    res.status(201).json({
      success: true,
      message: `Market Requisition #${reqNo} submitted to Store Owner!`,
      requisition: newReq,
    });
  } catch (e) {
    console.error('Error submitting market requisition:', e);
    res.status(500).json({ error: 'Failed to submit market requisition' });
  }
});

// PATCH /api/inventory/market-requisitions/:id/status - Update requisition status (e.g. RECEIVED)
router.patch('/market-requisitions/:id/status', (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const list = readMarketReqs();
    const idx = list.findIndex(r => r.id === id || r.reqNo === id);

    if (idx === -1) {
      return res.status(404).json({ error: 'Requisition not found' });
    }

    list[idx].status = status || list[idx].status;
    if (status === 'RECEIVED') {
      list[idx].receivedAt = new Date().toISOString();
    }

    writeMarketReqs(list);
    res.json({ success: true, requisition: list[idx] });
  } catch (e) {
    console.error('Error updating requisition status:', e);
    res.status(500).json({ error: 'Failed to update requisition status' });
  }
});

module.exports = router;
