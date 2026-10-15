const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');

/**
 * GET /api/sync/pull
 * Fetches all active PostgreSQL data for mobile offline caching & delta synchronization.
 */
router.get('/pull', async (req, res, next) => {
  try {
    const { lastSyncTime, full } = req.query;
    const sinceDate = (!full && lastSyncTime) ? new Date(lastSyncTime) : null;
    const isFullSync = full === 'true' || !sinceDate || isNaN(sinceDate.getTime());

    // 1. Products with Batches & Vendor Info (Always pull full products for reliable offline inventory)
    const products = await prisma.product.findMany({
      include: {
        vendor: { select: { id: true, name: true, area: true, contactNo: true } },
        batches: { orderBy: { expiryDate: 'asc' } }
      },
      orderBy: { name: 'asc' }
    });

    // 2. Customers
    const customers = await prisma.customer.findMany({
      orderBy: { name: 'asc' }
    });

    // 3. Vendors / Suppliers
    const vendors = await prisma.vendor.findMany({
      orderBy: { name: 'asc' }
    });

    // 4. Company & Branches
    const company = await prisma.company.findFirst({
      include: { branches: true }
    });

    // 5. Users & Permissions
    const users = await prisma.user.findMany({
      where: { isActive: true },
      include: { permissions: true }
    });

    // 6. Invoices (Always pull full historical invoices for offline lookup)
    const invoices = await prisma.invoice.findMany({
      include: {
        customer: { select: { id: true, name: true, address: true, accountNo: true } },
        items: {
          include: { product: { select: { name: true } } }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: 500
    });

    // 7. Purchases (Always pull full purchases for offline lookup)
    const purchases = await prisma.purchase.findMany({
      include: {
        vendor: { select: { id: true, name: true, area: true } },
        items: {
          include: { product: { select: { name: true } } }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: 500
    });

    // 8. Account Transactions / Ledgers (Always pull full transactions)
    const transactions = await prisma.accountTransaction.findMany({
      orderBy: { transactionDate: 'desc' },
      take: 500
    });

    // 9. HR Employees & Payroll
    const employees = await prisma.employee.findMany({
      where: { isActive: true },
      include: {
        attendances: { orderBy: { date: 'desc' }, take: 30 },
        advances: { orderBy: { requestDate: 'desc' }, take: 10 }
      }
    });

    // 10. Fixed Assets
    const fixedAssets = await prisma.fixedAsset.findMany({
      include: { depreciations: true }
    });

    // 11. Supplier Claims
    const supplierClaims = await prisma.supplierClaim.findMany({
      include: { items: true },
      orderBy: { claimDate: 'desc' }
    });

    res.json({
      success: true,
      serverTime: new Date().toISOString(),
      isFullSync,
      counts: {
        products: products.length,
        customers: customers.length,
        vendors: vendors.length,
        invoices: invoices.length,
        purchases: purchases.length,
        transactions: transactions.length,
        employees: employees.length,
        fixedAssets: fixedAssets.length,
        supplierClaims: supplierClaims.length
      },
      data: {
        products,
        customers,
        vendors,
        company,
        users,
        invoices,
        purchases,
        transactions,
        employees,
        fixedAssets,
        supplierClaims
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/sync/push
 * Uploads offline mutations (invoices, customer receipts, purchases, stock adjustments, attendance) into PostgreSQL.
 */
router.post('/push', async (req, res, next) => {
  try {
    const {
      invoices = [],
      transactions = [],
      purchases = [],
      stockAdjustments = [],
      attendances = [],
      products = []
    } = req.body;

    const syncResults = {
      invoicesSaved: 0,
      invoicesSkipped: 0,
      transactionsSaved: 0,
      purchasesSaved: 0,
      stockAdjustmentsSaved: 0,
      attendancesSaved: 0,
      productsSaved: 0,
      errors: []
    };

    // 1. Process Offline Invoices & Deduct Inventory
    for (const inv of invoices) {
      try {
        const existing = await prisma.invoice.findUnique({
          where: { invoiceNo: inv.invoiceNo }
        });

        if (existing) {
          syncResults.invoicesSkipped++;
          continue;
        }

        await prisma.$transaction(async (tx) => {
          await tx.invoice.create({
            data: {
              invoiceNo: inv.invoiceNo,
              customerId: inv.customerId,
              customerName: inv.customerName,
              customerAddress: inv.customerAddress,
              invoiceDate: new Date(inv.invoiceDate || Date.now()),
              salesman: inv.salesman || 'Mobile Cashier',
              totalAmount: parseFloat(inv.totalAmount || 0),
              status: inv.status || 'Active',
              createdAt: inv.createdAt ? new Date(inv.createdAt) : new Date(),
              items: {
                create: (inv.items || []).map((item) => ({
                  productId: item.productId,
                  batchId: item.batchId || null,
                  batchNo: item.batchNo || null,
                  expiryDate: item.expiryDate ? new Date(item.expiryDate) : null,
                  stp: parseFloat(item.stp || 0),
                  costPrice: parseFloat(item.costPrice || 0),
                  quantity: parseInt(item.quantity || 0, 10),
                  bonus: parseInt(item.bonus || 0, 10),
                  discount: parseFloat(item.discount || 0),
                  salesTax: parseFloat(item.salesTax || 0),
                  netAmount: parseFloat(item.netAmount || 0)
                }))
              }
            }
          });

          for (const item of (inv.items || [])) {
            const totalQty = (parseInt(item.quantity, 10) || 0) + (parseInt(item.bonus, 10) || 0);
            await tx.product.update({
              where: { id: item.productId },
              data: {
                stockQuantity: { decrement: totalQty },
                availableStock: { decrement: totalQty }
              }
            });

            if (item.batchId) {
              await tx.productBatch.update({
                where: { id: item.batchId },
                data: { quantity: { decrement: totalQty } }
              }).catch(() => {});
            }
          }

          if (inv.customerId) {
            await tx.accountTransaction.create({
              data: {
                voucherNo: `REC-MOB-${inv.invoiceNo}`,
                transactionType: 'CustomerReceipt',
                partyType: 'Customer',
                partyId: inv.customerId,
                partyName: inv.customerName,
                amount: parseFloat(inv.totalAmount || 0),
                paymentMethod: inv.paymentMethod || 'Cash',
                referenceNo: inv.invoiceNo,
                description: `Sale Invoice #${inv.invoiceNo} (Synced from Mobile)`,
                transactionDate: new Date(inv.invoiceDate || Date.now())
              }
            });
          }
        }, {
          maxWait: 20000,
          timeout: 60000,
        });

        syncResults.invoicesSaved++;
      } catch (err) {
        syncResults.errors.push({ type: 'invoice', invoiceNo: inv.invoiceNo, message: err.message });
      }
    }

    // 2. Process Financial Transactions (Receipts / Payments / Expenses)
    for (const trx of transactions) {
      try {
        const existing = await prisma.accountTransaction.findUnique({
          where: { voucherNo: trx.voucherNo }
        });

        if (!existing) {
          await prisma.accountTransaction.create({
            data: {
              voucherNo: trx.voucherNo,
              transactionType: trx.transactionType || 'CustomerReceipt',
              partyType: trx.partyType || 'Customer',
              partyId: trx.partyId || null,
              partyName: trx.partyName || null,
              amount: parseFloat(trx.amount || 0),
              paymentMethod: trx.paymentMethod || 'Cash',
              referenceNo: trx.referenceNo || null,
              description: trx.description || 'Mobile Sync Voucher',
              transactionDate: new Date(trx.transactionDate || Date.now())
            }
          });
          syncResults.transactionsSaved++;
        }
      } catch (err) {
        syncResults.errors.push({ type: 'transaction', voucherNo: trx.voucherNo, message: err.message });
      }
    }

    // 3. Process Stock Adjustments
    for (const adj of stockAdjustments) {
      try {
        await prisma.$transaction(async (tx) => {
          await tx.stockAdjustment.create({
            data: {
              productId: adj.productId,
              adjustmentType: adj.adjustmentType || 'PhysicalCount',
              quantity: parseInt(adj.quantity, 10),
              previousStock: parseInt(adj.previousStock, 10),
              newStock: parseInt(adj.newStock, 10),
              reason: adj.reason,
              adjustedBy: adj.adjustedBy || 'Mobile Admin'
            }
          });

          await tx.product.update({
            where: { id: adj.productId },
            data: {
              stockQuantity: parseInt(adj.newStock, 10),
              availableStock: parseInt(adj.newStock, 10)
            }
          });
        }, {
          maxWait: 20000,
          timeout: 60000,
        });
        syncResults.stockAdjustmentsSaved++;
      } catch (err) {
        syncResults.errors.push({ type: 'stockAdjustment', message: err.message });
      }
    }

    // 4. Process Attendance
    for (const att of attendances) {
      try {
        await prisma.attendance.create({
          data: {
            employeeId: att.employeeId,
            date: new Date(att.date || Date.now()),
            status: att.status || 'Present',
            timeIn: att.timeIn,
            timeOut: att.timeOut,
            overtimeHrs: parseFloat(att.overtimeHrs || 0),
            notes: att.notes
          }
        });
        syncResults.attendancesSaved++;
      } catch (err) {
        syncResults.errors.push({ type: 'attendance', message: err.message });
      }
    }

    res.json({
      success: true,
      serverTime: new Date().toISOString(),
      syncResults
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
