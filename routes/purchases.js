const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');

const parseExpiryDate = (val) => {
  if (!val) return null;
  const str = String(val).trim();
  if (!str) return null;

  // Handle MM/YY or MM/YYYY (e.g. "12/27" or "12/2027" or "03/28")
  if (str.includes('/')) {
    const parts = str.split('/');
    if (parts.length === 2) {
      const m = parseInt(parts[0], 10);
      let y = parseInt(parts[1], 10);
      if (y < 100) y += 2000;
      const lastDay = new Date(y, m, 0).getDate();
      return new Date(Date.UTC(y, m - 1, lastDay, 23, 59, 59));
    }
    if (parts.length === 3) {
      const d = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10);
      let y = parseInt(parts[2], 10);
      if (y < 100) y += 2000;
      return new Date(Date.UTC(y, m - 1, d, 23, 59, 59));
    }
  }

  // Handle YYYY-MM-DD
  if (str.includes('-')) {
    const parts = str.split('T')[0].split('-');
    if (parts.length === 3) {
      const y = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10);
      const d = parseInt(parts[2], 10);
      return new Date(Date.UTC(y, m - 1, d, 23, 59, 59));
    }
  }

  const parsed = new Date(str);
  return isNaN(parsed.getTime()) ? null : parsed;
};

const formatExpiryDateStr = (dateObj, rawStr) => {
  if (rawStr && String(rawStr).includes('/') && String(rawStr).split('/').length === 2) {
    return String(rawStr).trim();
  }
  if (!dateObj) return '';
  const m = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
  const y = String(dateObj.getUTCFullYear()).slice(-2);
  return `${m}/${y}`;
};

let inMemoryPurchases = [];

// GET /api/purchases - Read all purchase bills from PostgreSQL
router.get('/', async (req, res, next) => {
  try {
    const purchases = await prisma.purchase.findMany({
      include: {
        vendor: true,
        items: { include: { product: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const enrichedPurchases = purchases.map((p) => {
      const effectiveVendName = p.vendorName || (p.vendor ? p.vendor.name : 'General Vendor');
      const effectiveVendArea = p.vendorArea || (p.vendor ? p.vendor.area : 'Main Wholesale Market');
      return {
        ...p,
        vendorName: effectiveVendName,
        vendorArea: effectiveVendArea,
        vendor: {
          ...(p.vendor || {}),
          vendorNo: p.vendor ? p.vendor.vendorNo : 1,
          name: effectiveVendName,
          area: effectiveVendArea,
        },
      };
    });

    res.json(enrichedPurchases);
  } catch (error) {
    console.warn('Database query error, returning in-memory purchases:', error.message);
    res.json(inMemoryPurchases);
  }
});

// GET /api/purchases/last-item-purchase - Retrieve last purchase details for specific product & vendor
router.get('/last-item-purchase', async (req, res) => {
  try {
    const { vendorId, vendorNo, vendorName, productId, productCode, productName } = req.query;

    const vNo = (vendorNo || '').trim();
    const vName = (vendorName || '').trim();
    const pCode = (productCode || '').trim();
    const pName = (productName || '').trim();

    if (!productId && !pCode && !pName) {
      return res.json({ found: false });
    }

    let lastPurchase = null;
    let matchedItem = null;

    try {
      const itemWhere = {};
      if (productId) {
        itemWhere.productId = productId;
      } else if (pCode) {
        itemWhere.product = { productCode: String(pCode) };
      } else if (pName) {
        itemWhere.product = { name: { contains: pName, mode: 'insensitive' } };
      }

      // First attempt: look for purchase from specific vendor if provided
      if (vendorId || (vNo && !isNaN(Number(vNo))) || vName) {
        const vendWhere = {};
        if (vendorId) vendWhere.id = vendorId;
        else if (vNo && !isNaN(Number(vNo))) vendWhere.vendorNo = Number(vNo);
        else if (vName) vendWhere.name = { contains: vName, mode: 'insensitive' };

        const foundWithVendor = await prisma.purchase.findFirst({
          where: {
            vendor: vendWhere,
            items: { some: itemWhere },
          },
          orderBy: { purchaseDate: 'desc' },
          include: {
            vendor: true,
            items: { include: { product: true } },
          },
        });

        if (foundWithVendor && foundWithVendor.items && foundWithVendor.items.length > 0) {
          lastPurchase = foundWithVendor;
          matchedItem = foundWithVendor.items.find((it) => {
            if (productId && it.productId === productId) return true;
            if (pCode && it.product && String(it.product.productCode) === String(pCode)) return true;
            if (pName && it.product && it.product.name.toLowerCase().includes(pName.toLowerCase())) return true;
            return false;
          }) || foundWithVendor.items[0];
        }
      }

      // Second attempt: if not found with specific vendor, look for most recent purchase across ANY vendor
      if (!lastPurchase) {
        const foundAny = await prisma.purchase.findFirst({
          where: {
            items: { some: itemWhere },
          },
          orderBy: { purchaseDate: 'desc' },
          include: {
            vendor: true,
            items: { include: { product: true } },
          },
        });

        if (foundAny && foundAny.items && foundAny.items.length > 0) {
          lastPurchase = foundAny;
          matchedItem = foundAny.items.find((it) => {
            if (productId && it.productId === productId) return true;
            if (pCode && it.product && String(it.product.productCode) === String(pCode)) return true;
            if (pName && it.product && it.product.name.toLowerCase().includes(pName.toLowerCase())) return true;
            return false;
          }) || foundAny.items[0];
        }
      }
    } catch (dbErr) {
      console.warn('DB query error for last purchase:', dbErr.message);
    }

    // Fallback to in-memory purchases if DB didn't find
    if (!lastPurchase && inMemoryPurchases.length > 0) {
      for (const pur of inMemoryPurchases) {
        if (Array.isArray(pur.items)) {
          const item = pur.items.find((it) => {
            if (pCode && (String(it.code) === String(pCode) || String(it.productCode) === String(pCode))) return true;
            if (pName && (it.name || it.itemName || '').toLowerCase().includes(pName.toLowerCase())) return true;
            return false;
          });
          if (item) {
            lastPurchase = pur;
            matchedItem = item;
            break;
          }
        }
      }
    }

    if (!lastPurchase || !matchedItem) {
      return res.json({ found: false });
    }

    const rawDate = lastPurchase.purchaseDate || lastPurchase.createdAt || lastPurchase.date;
    const formattedDate = rawDate
      ? new Date(rawDate).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : 'Recently';

    const discVal = parseFloat(matchedItem.discount || matchedItem.disc || 0);
    const exDiscVal = parseFloat(matchedItem.extraDiscount || matchedItem.exDisc || 0);
    const stpVal = parseFloat(matchedItem.stp || matchedItem.price || 0);

    return res.json({
      found: true,
      purchaseNo: lastPurchase.purchaseNo,
      date: formattedDate,
      vendorName: lastPurchase.vendor ? lastPurchase.vendor.name : (lastPurchase.vendorName || vName || 'Supplier'),
      productName: matchedItem.product ? matchedItem.product.name : (matchedItem.name || pName),
      productCode: matchedItem.product ? matchedItem.product.productCode : (matchedItem.code || pCode),
      stp: stpVal,
      quantity: matchedItem.quantity !== undefined ? matchedItem.quantity : (matchedItem.qty1 || 1),
      bonus: matchedItem.bonus !== undefined ? matchedItem.bonus : (matchedItem.bon || 0),
      discount: discVal,
      extraDiscount: exDiscVal,
      salesTax: parseFloat(matchedItem.salesTax || matchedItem.stax || 0),
      netAmount: matchedItem.netAmount,
    });
  } catch (err) {
    console.warn('Error in /last-item-purchase route for purchases:', err);
    return res.json({ found: false });
  }
});

// POST /api/purchases - Save new Purchase Bill to PostgreSQL
router.post('/', async (req, res, next) => {
  try {
    const { purchaseNo, vendorId, vendorCode, vendorName, vendorArea, salesman, totalAmount, items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'At least one product item is required in the purchase bill.' });
    }

    // 1. Ensure Unique purchaseNo in PostgreSQL
    let targetPurchaseNo = String(purchaseNo || Date.now());
    const existingPur = await prisma.purchase.findUnique({
      where: { purchaseNo: targetPurchaseNo },
    });

    if (existingPur) {
      // If requested purchaseNo already exists, auto-increment to next available numeric purchaseNo
      const allPurchases = await prisma.purchase.findMany({ select: { purchaseNo: true } });
      const numericNos = allPurchases
        .map((p) => parseInt(p.purchaseNo, 10))
        .filter((n) => !isNaN(n));
      const maxNo = numericNos.length > 0 ? Math.max(...numericNos) : 0;
      targetPurchaseNo = String(maxNo + 1);
    }

    const finalTotal = totalAmount || items.reduce((acc, i) => acc + parseFloat(i.net || '0'), 0);

    // 2. Format custom vendor name if cash purchase or Vendor #1
    let resolvedVendName = (vendorName || 'General Vendor').trim();
    const isGeneralVendor = String(vendorCode || '1') === '1' || resolvedVendName.toLowerCase().includes('general') || resolvedVendName.toLowerCase().includes('cash');
    if (isGeneralVendor && resolvedVendName && resolvedVendName.toLowerCase() !== 'general vendor') {
      if (!resolvedVendName.toLowerCase().includes('cash purchase')) {
        resolvedVendName = `${resolvedVendName} (cash purchase)`;
      }
    }

    // 3. Find or link vendor in PostgreSQL
    let targetVendorId = null;
    if (isGeneralVendor) {
      // ALWAYS use Default General Vendor Account #1 in DB — DO NOT create a new vendor code!
      let defaultVendor = await prisma.vendor.findFirst({ where: { vendorNo: 1 } });
      if (!defaultVendor) {
        defaultVendor = await prisma.vendor.create({
          data: {
            vendorNo: 1,
            name: 'General Vendor',
            area: vendorArea || 'Main Wholesale Market',
            contactNo: 'N/A',
          },
        });
      }
      targetVendorId = defaultVendor.id;
    } else {
      if (vendorId) {
        const vendById = await prisma.vendor.findUnique({ where: { id: vendorId } });
        if (vendById) targetVendorId = vendById.id;
      }
      if (!targetVendorId && vendorCode && String(vendorCode) !== '1') {
        const vNum = parseInt(vendorCode, 10);
        if (!isNaN(vNum)) {
          const vendByCode = await prisma.vendor.findUnique({ where: { vendorNo: vNum } });
          if (vendByCode) targetVendorId = vendByCode.id;
        }
      }
      if (!targetVendorId && resolvedVendName && resolvedVendName.toLowerCase() !== 'general vendor') {
        const vendByName = await prisma.vendor.findFirst({
          where: { name: { equals: resolvedVendName, mode: 'insensitive' } },
        });
        if (vendByName) targetVendorId = vendByName.id;
      }
      if (!targetVendorId) {
        let defaultVendor = await prisma.vendor.findFirst({ where: { vendorNo: 1 } });
        if (!defaultVendor) {
          defaultVendor = await prisma.vendor.create({
            data: {
              vendorNo: 1,
              name: 'General Vendor',
              area: vendorArea || 'Main Wholesale Market',
              contactNo: 'N/A',
            },
          });
        }
        targetVendorId = defaultVendor.id;
      }
    }

    // 4. Ensure Products exist for each line item
    const purchaseItemsData = [];
    for (const item of items) {
      let prod = null;
      const codeStr = String(item.code || item.productCode || '1');

      if (item.productId) {
        prod = await prisma.product.findUnique({ where: { id: item.productId } });
      }
      if (!prod && codeStr) {
        prod = await prisma.product.findFirst({ where: { productCode: codeStr } });
      }
      const itemQty = parseInt(item.qty1 || '1', 10);
      const itemBon = parseInt(item.bon || '0', 10);
      const itemNet = parseFloat(item.net || '0');
      const itemStp = parseFloat(item.stp || '0');
      const totalUnitsReceived = itemQty + itemBon;
      const unitCost = itemNet > 0 && totalUnitsReceived > 0 
        ? itemNet / totalUnitsReceived 
        : (itemStp > 0 && totalUnitsReceived > 0 ? (itemStp * itemQty) / totalUnitsReceived : itemStp);

      // Calculate Effective Discount % (Bonus Scheme + Trade Disc + Extra Disc)
      const totalGrossVal = totalUnitsReceived * itemStp;
      const effectiveExDisc = totalGrossVal > 0 && itemNet > 0
        ? Math.max(0, parseFloat((((totalGrossVal - itemNet) / totalGrossVal) * 100).toFixed(2)))
        : (itemBon > 0 && totalUnitsReceived > 0 ? parseFloat(((itemBon / totalUnitsReceived) * 100 + itemExDisc).toFixed(2)) : itemExDisc);

      const targetBatchNo = (item.batch || item.batchNo || 'B-101').trim();
      const parsedExpiry = parseExpiryDate(item.expiry || item.expiryDate);
      const formattedExpStr = formatExpiryDateStr(parsedExpiry, item.expiry || item.expiryDate);

      if (!prod) {
        // Create product if missing
        prod = await prisma.product.create({
          data: {
            productCode: codeStr,
            name: item.name || `Medicine ${codeStr}`,
            vendorId: targetVendorId,
            retailPrice: parseFloat(item.retail || item.stp || '100'),
            tradePrice: itemStp || 86,
            costPrice: parseFloat(unitCost.toFixed(2)) || itemStp || 86,
            extraDiscount: effectiveExDisc,
            batchNo: targetBatchNo,
            expiryDate: parsedExpiry,
            stockQuantity: totalUnitsReceived,
          },
        });
      } else {
        // Calculate Weighted Moving Average Cost Price & Extra Discount %
        const currentQty = Math.max(0, prod.stockQuantity || 0);
        const currentCost = parseFloat(prod.costPrice || prod.tradePrice || unitCost || '0');
        const currentExDisc = parseFloat(prod.extraDiscount || '0');

        const incomingQty = totalUnitsReceived;
        const incomingNetCost = unitCost;

        let weightedCostPrice = unitCost;
        let weightedExtraDiscount = effectiveExDisc;

        if (currentQty > 0 && incomingQty > 0) {
          const totalOldValue = currentQty * currentCost;
          const totalNewValue = incomingQty * incomingNetCost;
          const totalQty = currentQty + incomingQty;

          weightedCostPrice = totalQty > 0 ? (totalOldValue + totalNewValue) / totalQty : unitCost;

          const totalOldDisc = currentQty * currentExDisc;
          const totalNewDisc = incomingQty * effectiveExDisc;
          weightedExtraDiscount = totalQty > 0 ? (totalOldDisc + totalNewDisc) / totalQty : effectiveExDisc;
        }

        // Update stock quantity and weighted average cost price for existing product
        await prisma.product.update({
          where: { id: prod.id },
          data: {
            stockQuantity: { increment: incomingQty },
            costPrice: parseFloat(weightedCostPrice.toFixed(2)),
            extraDiscount: parseFloat(weightedExtraDiscount.toFixed(2)),
            tradePrice: itemStp > 0 ? itemStp : prod.tradePrice,
            retailPrice: parseFloat(item.retail || '0') > 0 ? parseFloat(item.retail) : prod.retailPrice,
            batchNo: targetBatchNo,
            expiryDate: parsedExpiry || prod.expiryDate,
          },
        });
      }

      // Upsert ProductBatch for specific batch tracking
      try {
        const existingBatch = await prisma.productBatch.findUnique({
          where: {
            productId_batchNo: {
              productId: prod.id,
              batchNo: targetBatchNo,
            },
          },
        });

        if (existingBatch) {
          await prisma.productBatch.update({
            where: { id: existingBatch.id },
            data: {
              quantity: { increment: totalUnitsReceived },
              expiryDate: parsedExpiry || existingBatch.expiryDate,
              expiryDateFormatted: formattedExpStr || existingBatch.expiryDateFormatted,
              costPrice: parseFloat(unitCost.toFixed(2)),
              tradePrice: itemStp > 0 ? itemStp : existingBatch.tradePrice,
              retailPrice: parseFloat(item.retail || '0') > 0 ? parseFloat(item.retail) : existingBatch.retailPrice,
            },
          });
        } else {
          await prisma.productBatch.create({
            data: {
              productId: prod.id,
              batchNo: targetBatchNo,
              expiryDate: parsedExpiry,
              expiryDateFormatted: formattedExpStr,
              quantity: totalUnitsReceived,
              costPrice: parseFloat(unitCost.toFixed(2)),
              tradePrice: itemStp > 0 ? itemStp : (prod.tradePrice || 0),
              retailPrice: parseFloat(item.retail || '0') > 0 ? parseFloat(item.retail) : (prod.retailPrice || 0),
            },
          });
        }
      } catch (batchErr) {
        console.warn('Error recording ProductBatch:', batchErr.message);
      }

      purchaseItemsData.push({
        productId: prod.id,
        batchNo: targetBatchNo,
        expiryDate: parsedExpiry,
        stp: parseFloat(item.stp || '0'),
        quantity: parseInt(item.qty1 || '1', 10),
        bonus: parseInt(item.bon || '0', 10),
        discount: parseFloat(item.disc ? String(item.disc).replace('%', '') : '0'),
        extraDiscount: parseFloat(item.exDisc ? String(item.exDisc).replace('%', '') : '0'),
        salesTax: parseFloat(item.stax || '0'),
        netAmount: parseFloat(item.net || '0'),
      });
    }

    // 5. Create Purchase Bill & Items in PostgreSQL
    const createdPurchase = await prisma.purchase.create({
      data: {
        purchaseNo: targetPurchaseNo,
        vendorId: targetVendorId,
        vendorName: resolvedVendName,
        vendorArea: vendorArea || 'Main Wholesale Market',
        purchaseDate: new Date(req.body.purchaseDate || Date.now()),
        salesman: salesman || 'Default Salesman',
        totalAmount: parseFloat(finalTotal),
        items: {
          create: purchaseItemsData,
        },
      },
      include: { vendor: true, items: { include: { product: true } } },
    });

    console.log(`[SUCCESS] Saved Purchase Bill #${targetPurchaseNo} to PostgreSQL database!`);
    return res.status(201).json(createdPurchase);
  } catch (error) {
    console.error('Error saving purchase bill to PostgreSQL:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/purchases/:id - Edit existing Purchase Bill in PostgreSQL
router.put('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { vendorName, salesman, totalAmount, items } = req.body;

    const existing = await prisma.purchase.findUnique({
      where: { id },
      include: { items: true },
    });

    if (!existing) {
      const inMemIndex = inMemoryPurchases.findIndex((p) => p.id === id);
      if (inMemIndex !== -1) {
        inMemoryPurchases[inMemIndex] = {
          ...inMemoryPurchases[inMemIndex],
          vendorName: vendorName || inMemoryPurchases[inMemIndex].vendorName,
          salesman: salesman || inMemoryPurchases[inMemIndex].salesman,
          totalAmount: parseFloat(totalAmount || 0),
          items: items || inMemoryPurchases[inMemIndex].items,
          updatedAt: new Date(),
        };
        return res.json(inMemoryPurchases[inMemIndex]);
      }
      return res.status(404).json({ error: 'Purchase Bill not found' });
    }

    const updatedItemsData = [];
    if (items && Array.isArray(items)) {
      for (const item of items) {
        let prod = null;
        const codeStr = String(item.code || item.productCode || '1');

        if (item.productId) {
          prod = await prisma.product.findUnique({ where: { id: item.productId } });
        }
        if (!prod && codeStr) {
          prod = await prisma.product.findFirst({ where: { productCode: codeStr } });
        }
        if (!prod) {
          prod = await prisma.product.create({
            data: {
              productCode: codeStr,
              name: item.name || `Medicine ${codeStr}`,
              vendorId: existing.vendorId,
              retailPrice: parseFloat(item.retail || item.stp || '100'),
              tradePrice: parseFloat(item.stp || '86'),
              costPrice: parseFloat(item.stp || '86'),
              batchNo: item.batch || 'B-101',
              stockQuantity: parseInt(item.qty1 || '1', 10),
            },
          });
        }

        updatedItemsData.push({
          productId: prod.id,
          stp: parseFloat(item.stp || item.price || '0'),
          quantity: parseInt(item.quantity || item.qty1 || '1', 10),
          bonus: parseInt(item.bonus || item.bon || '0', 10),
          discount: parseFloat(item.discount !== undefined ? item.discount : (item.disc ? String(item.disc).replace('%', '') : '0')),
          extraDiscount: parseFloat(item.extraDiscount !== undefined ? item.extraDiscount : (item.exDisc ? String(item.exDisc).replace('%', '') : '0')),
          salesTax: parseFloat(item.salesTax || item.stax || '0'),
          netAmount: parseFloat(item.netAmount || item.net || '0'),
        });
      }
    }

    const updatedPurchase = await prisma.$transaction(async (tx) => {
      await tx.purchaseItem.deleteMany({ where: { purchaseId: id } });

      return await tx.purchase.update({
        where: { id },
        data: {
          salesman: salesman || existing.salesman,
          totalAmount: parseFloat(totalAmount || existing.totalAmount),
          items: {
            create: updatedItemsData,
          },
        },
        include: { vendor: true, items: { include: { product: true } } },
      });
    }, {
      maxWait: 20000,
      timeout: 60000,
    });

    console.log(`[SUCCESS] Updated Purchase Bill #${updatedPurchase.purchaseNo} in PostgreSQL database!`);
    return res.json(updatedPurchase);
  } catch (error) {
    console.error('Error updating purchase bill:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// DELETE /api/purchases/:id - Delete Purchase Bill from PostgreSQL
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await prisma.purchase.findUnique({ where: { id } });
    if (existing) {
      await prisma.$transaction([
        prisma.purchaseItem.deleteMany({ where: { purchaseId: id } }),
        prisma.purchase.delete({ where: { id } }),
      ]);
    } else {
      inMemoryPurchases = inMemoryPurchases.filter((p) => p.id !== id);
    }
    return res.json({ success: true, message: 'Purchase bill deleted successfully.' });
  } catch (err) {
    console.error('Error deleting purchase:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
