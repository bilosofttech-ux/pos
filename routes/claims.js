const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');

// 1. GET /api/claims - Fetch all supplier claims with vendor details
router.get('/', async (req, res) => {
  try {
    const claims = await prisma.supplierClaim.findMany({
      include: {
        vendor: {
          select: { id: true, name: true, vendorNo: true, area: true, contactNo: true },
        },
        items: {
          include: {
            product: { select: { name: true, productCode: true, unit: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(claims);
  } catch (error) {
    console.error('Error fetching supplier claims:', error);
    res.status(500).json({ error: 'Failed to fetch supplier claims' });
  }
});

// 2. GET /api/claims/eligible-returns - Fetch expired, near-expiry, or damaged items eligible for supplier return
router.get('/eligible-returns', async (req, res) => {
  try {
    const now = new Date();
    const future60Days = new Date();
    future60Days.setDate(now.getDate() + 60);

    const eligibleProducts = await prisma.product.findMany({
      where: {
        OR: [
          { expiryDate: { lte: future60Days } },
          { isQuarantined: true },
        ],
      },
      include: {
        vendor: { select: { id: true, name: true, vendorNo: true } },
      },
    });

    res.json(eligibleProducts);
  } catch (error) {
    console.error('Error fetching eligible return items:', error);
    res.status(500).json({ error: 'Failed to fetch eligible return items' });
  }
});

// 3. POST /api/claims - Create a new Supplier Return Debit Note
router.post('/', async (req, res) => {
  try {
    const { vendorId, claimType, notes, createdByName, items } = req.body;

    if (!vendorId || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Vendor ID and return items are required' });
    }

    const count = await prisma.supplierClaim.count();
    const claimNo = `SCN-${String(count + 1001)}`;

    let totalAmount = 0;
    const claimItemData = [];

    // Calculate totals and validate stock adjustment
    for (const item of items) {
      const lineNet = parseFloat(item.unitPrice || 0) * parseInt(item.quantity || 1, 10);
      totalAmount += lineNet;

      claimItemData.push({
        productId: item.productId,
        batchNo: item.batchNo || null,
        expiryDate: item.expiryDate ? new Date(item.expiryDate) : null,
        unitPrice: parseFloat(item.unitPrice || 0),
        quantity: parseInt(item.quantity || 1, 10),
        netAmount: lineNet,
        reason: item.reason || claimType || 'Expired Return',
      });
    }

    // Perform database transaction: Create Claim + Deduct Stock + Log Stock Adjustment
    const newClaim = await prisma.$transaction(async (tx) => {
      const claim = await tx.supplierClaim.create({
        data: {
          claimNo,
          vendorId,
          claimType: claimType || 'ExpiredReturn',
          status: 'Pending',
          totalAmount,
          notes: notes || 'Supplier return debit note generated',
          createdByName: createdByName || 'Admin',
          items: {
            create: claimItemData,
          },
        },
        include: {
          vendor: true,
          items: { include: { product: true } },
        },
      });

      // Deduct stock for each returned item & log StockAdjustment
      for (const item of items) {
        const prod = await tx.product.findUnique({ where: { id: item.productId } });
        if (prod) {
          const qtyToReturn = parseInt(item.quantity || 1, 10);
          const updatedStock = Math.max(0, prod.stockQuantity - qtyToReturn);

          await tx.product.update({
            where: { id: item.productId },
            data: {
              stockQuantity: updatedStock,
              availableStock: Math.max(0, updatedStock - (prod.reservedStock || 0)),
            },
          });

          await tx.stockAdjustment.create({
            data: {
              productId: item.productId,
              adjustmentType: 'Return',
              quantity: qtyToReturn,
              previousStock: prod.stockQuantity,
              newStock: updatedStock,
              reason: `Returned to Supplier (${claimNo}): ${item.reason || 'Expired / Damaged Return'}`,
              adjustedBy: createdByName || 'Admin',
            },
          });
        }
      }

      // Log financial Debit Note in AccountTransaction so vendor payable balance is reduced in real-time
      const txCount = await tx.accountTransaction.count();
      const vendorObj = claim.vendor || (await tx.vendor.findUnique({ where: { id: vendorId } }));

      await tx.accountTransaction.create({
        data: {
          voucherNo: `DN-${String(txCount + 1001)}`,
          transactionType: 'SupplierPayment',
          partyType: 'Vendor',
          partyId: vendorId,
          partyName: vendorObj ? vendorObj.name : 'Supplier',
          amount: totalAmount,
          paymentMethod: 'DebitNote',
          referenceNo: claimNo,
          description: `Supplier Return Debit Note (${claimNo}) for Expired/Damaged Stock Return`,
        },
      });

      return claim;
    }, {
      maxWait: 20000,
      timeout: 60000,
    });

    res.status(201).json(newClaim);
  } catch (error) {
    console.error('Error creating supplier claim:', error);
    res.status(500).json({ error: 'Failed to create supplier claim' });
  }
});

// 4. PATCH /api/claims/:id/status - Update Supplier Claim Status (Pending -> Approved -> Adjusted)
router.patch('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    if (!['Pending', 'Approved', 'Adjusted', 'Refunded', 'Rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }

    const claim = await prisma.supplierClaim.findUnique({
      where: { id },
      include: { vendor: true },
    });

    if (!claim) return res.status(404).json({ error: 'Supplier claim not found' });

    const updatedClaim = await prisma.supplierClaim.update({
      where: { id },
      data: {
        status,
        notes: notes || claim.notes,
      },
    });

    // If claim status becomes Adjusted or Refunded, check if debit voucher exists before logging
    if ((status === 'Adjusted' || status === 'Refunded') && claim.status !== 'Adjusted' && claim.status !== 'Refunded') {
      const existingTx = await prisma.accountTransaction.findFirst({
        where: { referenceNo: claim.claimNo },
      });
      if (!existingTx) {
        const count = await prisma.accountTransaction.count();
        await prisma.accountTransaction.create({
          data: {
            voucherNo: `DN-${String(count + 1001)}`,
            transactionType: 'SupplierPayment',
            partyType: 'Vendor',
            partyId: claim.vendorId,
            partyName: claim.vendor ? claim.vendor.name : 'Supplier',
            amount: claim.totalAmount,
            paymentMethod: status === 'Refunded' ? 'Cash' : 'DebitNote',
            referenceNo: claim.claimNo,
            description: `Supplier Return Claim (${claim.claimNo}) ${status} credit adjustment`,
          },
        });
      }
    }

    res.json(updatedClaim);
  } catch (error) {
    console.error('Error updating claim status:', error);
    res.status(500).json({ error: 'Failed to update supplier claim status' });
  }
});

module.exports = router;
