const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');

let inMemorySales = [];

// GET /api/sales - List sales (invoices)
router.get('/', async (req, res, next) => {
  try {
    const invoices = await prisma.invoice.findMany({
      include: {
        customer: true,
        items: { include: { product: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(invoices);
  } catch (error) {
    console.warn('Database query error in /api/sales, returning in-memory sales:', error.message);
    res.json(inMemorySales);
  }
});

// POST /api/sales - Create sale (invoice)
router.post('/', async (req, res, next) => {
  try {
    const { customerId, customerName, salesman, items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'At least one item is required' });
    }

    try {
      const newInvoice = await prisma.$transaction(async (tx) => {
        let targetCustomerId = customerId;
        if (!targetCustomerId && customerName) {
          const cust = await tx.customer.findFirst({ where: { name: customerName } });
          if (cust) targetCustomerId = cust.id;
        }
        if (!targetCustomerId) {
          let counterCust = await tx.customer.findFirst({ where: { accountNo: 1 } });
          if (!counterCust) {
            counterCust = await tx.customer.create({
              data: { accountNo: 1, name: 'Counter Sale', address: 'Local Wholesale Market', contactNo: 'N/A' },
            });
          }
          targetCustomerId = counterCust.id;
        }

        let total = 0;
        const invoiceItemsData = [];

        for (const item of items) {
          const prodId = item.productId || item.id;
          const prod = await tx.product.findUnique({ where: { id: prodId } });
          if (!prod) {
            const err = new Error(`Product ${prodId} not found`);
            err.statusCode = 404;
            throw err;
          }

          const qty = parseInt(item.quantity || item.qty || '1', 10);
          if (prod.stockQuantity < qty) {
            const err = new Error(`Insufficient stock for ${prod.name} (Available: ${prod.stockQuantity})`);
            err.statusCode = 400;
            throw err;
          }

          const unitPrice = item.stp !== undefined ? Number(item.stp) : (item.price !== undefined ? Number(item.price) : Number(prod.tradePrice));
          total += unitPrice * qty;

          await tx.product.update({
            where: { id: prod.id },
            data: { stockQuantity: { decrement: qty } },
          });

          invoiceItemsData.push({
            productId: prod.id,
            stp: unitPrice,
            quantity: qty,
            bonus: parseInt(item.bonus || item.bon || '0', 10),
            discount: parseFloat(item.discount !== undefined ? item.discount : '0'),
            salesTax: parseFloat(item.salesTax || item.stax || '0'),
            netAmount: unitPrice * qty,
          });
        }

        const invoiceNo = String(Date.now());
        return await tx.invoice.create({
          data: {
            invoiceNo,
            totalAmount: total,
            customerId: targetCustomerId,
            invoiceDate: new Date(),
            salesman: salesman || 'Counter Sale',
            items: { create: invoiceItemsData },
          },
          include: { customer: true, items: { include: { product: true } } },
        });
      }, {
        maxWait: 20000,
        timeout: 60000,
      });

      return res.status(201).json(newInvoice);
    } catch (dbErr) {
      if (dbErr.statusCode) {
        return res.status(dbErr.statusCode).json({ error: dbErr.message });
      }

      console.warn('Database offline, processing sale in-memory');
      const fallbackSale = {
        id: `sale-${Date.now()}`,
        invoiceNo: String(Date.now()),
        totalAmount: items.reduce((sum, i) => sum + (i.price || i.stp || 10) * (i.quantity || 1), 0),
        customerId: customerId || null,
        items,
        createdAt: new Date(),
      };
      inMemorySales.unshift(fallbackSale);
      return res.status(201).json(fallbackSale);
    }
  } catch (error) {
    next(error);
  }
});

module.exports = router;

