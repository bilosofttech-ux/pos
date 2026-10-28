const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');

let inMemoryInvoices = [];

// GET /api/invoices - Fetch all invoices with search filtering & payment breakdowns
router.get('/', async (req, res, next) => {
  try {
    const { search } = req.query;
    const userId = req.headers['x-user-id'] || req.query.userId;
    const userRole = req.headers['x-user-role'];

    const where = {};
    if (userId && userRole !== 'SuperAdmin') {
      where.userId = userId;
    }

    if (search) {
      where.AND = [
        {
          OR: [
            { invoiceNo: { contains: search } },
            { customer: { name: { contains: search } } },
            { salesman: { contains: search } },
          ],
        },
      ];
    }

    const [invoices, transactions] = await Promise.all([
      prisma.invoice.findMany({
        where,
        include: {
          customer: true,
          items: { include: { product: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.accountTransaction.findMany({
        where: { partyType: 'Customer' },
      }),
    ]);

    const enrichedInvoices = invoices.map((inv) => {
      const relatedTxs = transactions.filter(
        (t) =>
          t.voucherNo === `REC-POS-${inv.invoiceNo}` ||
          t.voucherNo === `REC-POS-${inv.invoiceNo}-CASH` ||
          t.voucherNo === `REC-POS-${inv.invoiceNo}-BANK` ||
          t.voucherNo.startsWith(`REC-POS-EDIT-${inv.invoiceNo}`) ||
          t.voucherNo.startsWith(`REFUND-POS-${inv.invoiceNo}`) ||
          (t.referenceNo && t.referenceNo.includes(`Inv #${inv.invoiceNo}`))
      );

      let cashPaid = 0;
      let bankPaid = 0;
      let bankRef = '';
      let paymentMethod = 'Credit';
      let isEdited = relatedTxs.some((t) => t.voucherNo.includes('EDIT') || t.voucherNo.includes('REFUND'));

      if (relatedTxs.length > 0) {
        relatedTxs.forEach((t) => {
          const m = (t.paymentMethod || '').toLowerCase();
          const isBank = m.includes('bank') || m.includes('card') || m.includes('online') || m.includes('easypaisa') || m.includes('jazzcash') || m.includes('ibft');
          const isRefund = t.transactionType === 'Expense' || t.transactionType === 'Refund';
          const amt = isRefund ? -(t.amount || 0) : (t.amount || 0);

          if (isBank) {
            bankPaid += amt;
            if (t.referenceNo) bankRef = t.referenceNo;
          } else {
            cashPaid += amt;
          }
        });

        if (cashPaid > 0 && bankPaid > 0) paymentMethod = 'Split';
        else if (bankPaid > 0) paymentMethod = 'BankTransfer';
        else if (cashPaid > 0) paymentMethod = 'Cash';
      }

      const totalPaid = cashPaid + bankPaid;
      const balanceDue = Math.max(0, (inv.totalAmount || 0) - totalPaid);
      const effectiveCustName = inv.customerName || (inv.customer ? inv.customer.name : 'Counter Sale');
      const effectiveCustAddr = inv.customerAddress || (inv.customer ? inv.customer.address : 'Local Wholesale Market');

      return {
        id: inv.id,
        invoiceNo: inv.invoiceNo,
        customerId: inv.customerId,
        customerName: effectiveCustName,
        customerAddress: effectiveCustAddr,
        invoiceDate: inv.invoiceDate,
        salesman: inv.salesman,
        totalAmount: inv.totalAmount,
        createdAt: inv.createdAt,
        updatedAt: inv.updatedAt,
        customer: {
          ...(inv.customer || {}),
          id: inv.customerId || inv.customer?.id,
          accountNo: inv.customer ? inv.customer.accountNo : 1,
          name: effectiveCustName,
          address: effectiveCustAddr,
        },
        items: inv.items || [],
        paidAmount: totalPaid,
        cashPaid,
        bankPaid,
        bankRef,
        balanceDue,
        paymentMethod,
        isEdited,
        status: inv.status || (inv.isReturned ? 'Returned' : 'Active'),
        isReturned: Boolean(inv.isReturned),
        returnDate: inv.returnDate,
        returnRefundMethod: inv.returnRefundMethod,
        returnRefundAmount: inv.returnRefundAmount,
        returnReason: inv.returnReason,
      };
    });

    res.json(enrichedInvoices);
  } catch (error) {
    console.warn('Database query error, returning in-memory invoices:', error.message);
    res.json(inMemoryInvoices);
  }
});

// GET /api/invoices/item-sales-history - Detailed search of item sales with date/month filters & customer info
router.get('/item-sales-history', async (req, res) => {
  try {
    const {
      query,
      itemName,
      productId,
      filterType = 'ALL',
      date,
      startDate,
      endDate,
      month,
      year,
      customerQuery,
    } = req.query;

    const searchStr = (query || itemName || '').trim();
    const custSearchStr = (customerQuery || '').trim();

    const whereItem = {};

    // 1. Product Filter
    if (productId) {
      whereItem.productId = productId;
    } else if (searchStr) {
      whereItem.product = {
        OR: [
          { name: { contains: searchStr } },
          { productCode: { contains: searchStr } },
          { genericName: { contains: searchStr } },
          { barcode: { contains: searchStr } },
        ],
      };
    }

    // 2. Invoice Date & Customer Filters
    const invoiceWhere = {};

    // Customer filter
    if (custSearchStr) {
      const isNum = !isNaN(Number(custSearchStr));
      invoiceWhere.customer = {
        OR: [
          { name: { contains: custSearchStr } },
          { contactNo: { contains: custSearchStr } },
          ...(isNum ? [{ accountNo: Number(custSearchStr) }] : []),
        ],
      };
    }

    // Date filters
    if (filterType === 'SPECIFIC_DATE' && date) {
      const dayStart = new Date(`${date}T00:00:00.000Z`);
      const dayEnd = new Date(`${date}T23:59:59.999Z`);
      invoiceWhere.invoiceDate = { gte: dayStart, lte: dayEnd };
    } else if (filterType === 'DATE_ONWARDS' && date) {
      const dayStart = new Date(`${date}T00:00:00.000Z`);
      invoiceWhere.invoiceDate = { gte: dayStart };
    } else if (filterType === 'DATE_RANGE') {
      const dateCond = {};
      if (startDate) dateCond.gte = new Date(`${startDate}T00:00:00.000Z`);
      if (endDate) dateCond.lte = new Date(`${endDate}T23:59:59.999Z`);
      if (Object.keys(dateCond).length > 0) {
        invoiceWhere.invoiceDate = dateCond;
      }
    } else if (filterType === 'MONTH_WISE' && month && year) {
      const m = parseInt(month, 10);
      const y = parseInt(year, 10);
      const firstDay = new Date(y, m - 1, 1, 0, 0, 0, 0);
      const lastDay = new Date(y, m, 0, 23, 59, 59, 999);
      invoiceWhere.invoiceDate = { gte: firstDay, lte: lastDay };
    }

    if (Object.keys(invoiceWhere).length > 0) {
      whereItem.invoice = invoiceWhere;
    }

    // Query InvoiceItems from Database
    const items = await prisma.invoiceItem.findMany({
      where: whereItem,
      include: {
        product: true,
        invoice: {
          include: {
            customer: true,
          },
        },
      },
      orderBy: {
        invoice: {
          invoiceDate: 'desc',
        },
      },
      take: 500,
    });

    // Compute KPI metrics
    let totalQty = 0;
    let totalBonus = 0;
    let totalSalesAmount = 0;
    const uniqueCustomerIds = new Set();
    const invoiceNos = new Set();

    const formattedRecords = items.map((item) => {
      const qty = item.quantity || 0;
      const bonus = item.bonus || 0;
      const net = item.netAmount || (item.stp * qty);

      totalQty += qty;
      totalBonus += bonus;
      totalSalesAmount += net;
      if (item.invoice?.customerId) uniqueCustomerIds.add(item.invoice.customerId);
      if (item.invoice?.invoiceNo) invoiceNos.add(item.invoice.invoiceNo);

      return {
        id: item.id,
        invoiceId: item.invoiceId,
        invoiceNo: item.invoice?.invoiceNo || 'N/A',
        invoiceDate: item.invoice?.invoiceDate || item.invoice?.createdAt,
        salesman: item.invoice?.salesman || 'N/A',
        isReturned: item.invoice?.isReturned || false,
        status: item.invoice?.status || 'Active',
        customer: {
          id: item.invoice?.customer?.id,
          accountNo: item.invoice?.customer?.accountNo,
          name: item.invoice?.customer?.name || 'Walk-in Customer',
          address: item.invoice?.customer?.address,
          contactNo: item.invoice?.customer?.contactNo,
        },
        product: {
          id: item.product?.id,
          productCode: item.product?.productCode,
          name: item.product?.name,
          genericName: item.product?.genericName,
          unit: item.product?.unit,
          packSize: item.product?.packSize,
        },
        quantity: qty,
        bonus: bonus,
        stp: item.stp,
        discount: item.discount || 0,
        extraDiscount: item.extraDiscount || 0,
        salesTax: item.salesTax || 0,
        netAmount: net,
      };
    });

    res.json({
      summary: {
        totalRecords: formattedRecords.length,
        totalQty,
        totalBonus,
        totalSalesAmount,
        uniqueCustomersCount: uniqueCustomerIds.size,
        totalInvoicesCount: invoiceNos.size,
        avgPrice: totalQty > 0 ? (totalSalesAmount / totalQty) : 0,
      },
      records: formattedRecords,
    });
  } catch (error) {
    console.error('Error fetching item sales history:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/invoices/last-item-purchase - Retrieve last purchase details for specific customer & item
router.get('/last-item-purchase', async (req, res) => {
  try {
    const { customerAccNo, customerName, productId, productCode, productName } = req.query;

    const cAcc = (customerAccNo || '').trim();
    const cName = (customerName || '').trim();
    const pCode = (productCode || '').trim();
    const pName = (productName || '').trim();

    if (!cAcc && !cName) {
      return res.json({ found: false });
    }
    if (!productId && !pCode && !pName) {
      return res.json({ found: false });
    }

    // Search DB for last invoice
    let lastInvoice = null;
    let matchedItem = null;

    try {
      const invWhere = {
        isReturned: false,
      };

      if (cAcc && !isNaN(Number(cAcc))) {
        invWhere.customer = { accountNo: Number(cAcc) };
      } else if (cName) {
        invWhere.customer = { name: { contains: cName } };
      }

      const itemWhere = {};
      if (productId) {
        itemWhere.productId = productId;
      } else if (pCode) {
        itemWhere.product = { productCode: String(pCode) };
      } else if (pName) {
        itemWhere.product = { name: { contains: pName } };
      }

      const foundInvoice = await prisma.invoice.findFirst({
        where: {
          ...invWhere,
          items: {
            some: itemWhere,
          },
        },
        orderBy: { createdAt: 'desc' },
        include: {
          customer: true,
          items: {
            include: { product: true },
          },
        },
      });

      if (foundInvoice && foundInvoice.items && foundInvoice.items.length > 0) {
        lastInvoice = foundInvoice;
        matchedItem = foundInvoice.items.find((it) => {
          if (productId && it.productId === productId) return true;
          if (pCode && it.product && String(it.product.productCode) === String(pCode)) return true;
          if (pName && it.product && it.product.name.toLowerCase().includes(pName.toLowerCase())) return true;
          return true;
        }) || foundInvoice.items[0];
      }
    } catch (dbErr) {
      console.warn('DB search failed for last purchase, fallback to in-memory:', dbErr.message);
    }

    // Fallback to inMemoryInvoices if DB didn't find
    if (!lastInvoice && inMemoryInvoices.length > 0) {
      for (const inv of inMemoryInvoices) {
        if (inv.isReturned) continue;
        const matchesCust = (cAcc && String(inv.customerAccNo) === String(cAcc)) ||
          (cName && inv.customerName && inv.customerName.toLowerCase().includes(cName.toLowerCase()));

        if (matchesCust && Array.isArray(inv.items)) {
          const item = inv.items.find((it) => {
            if (pCode && (String(it.code) === String(pCode) || String(it.productCode) === String(pCode))) return true;
            if (pName && (it.name || it.itemName || '').toLowerCase().includes(pName.toLowerCase())) return true;
            return false;
          });

          if (item) {
            lastInvoice = inv;
            matchedItem = item;
            break;
          }
        }
      }
    }

    if (!lastInvoice || !matchedItem) {
      return res.json({ found: false });
    }

    const rawDate = lastInvoice.invoiceDate || lastInvoice.createdAt || lastInvoice.date;
    const formattedDate = rawDate
      ? new Date(rawDate).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : 'Recently';

    return res.json({
      found: true,
      invoiceNo: lastInvoice.invoiceNo,
      date: formattedDate,
      customerName: lastInvoice.customer ? lastInvoice.customer.name : (lastInvoice.customerName || cName),
      productName: matchedItem.product ? matchedItem.product.name : (matchedItem.name || matchedItem.itemName || pName),
      stp: matchedItem.stp !== undefined ? matchedItem.stp : (matchedItem.price || 0),
      quantity: matchedItem.quantity !== undefined ? matchedItem.quantity : (matchedItem.qty || 1),
      bonus: matchedItem.bonus !== undefined ? matchedItem.bonus : (matchedItem.bon || 0),
      discount: matchedItem.discount !== undefined ? matchedItem.discount : (matchedItem.disc || 0),
      salesTax: matchedItem.salesTax !== undefined ? matchedItem.salesTax : (matchedItem.stax || 0),
      netAmount: matchedItem.netAmount,
    });
  } catch (err) {
    console.warn('Error in /last-item-purchase route:', err);
    return res.json({ found: false });
  }
});

// GET /api/invoices/profit-summary - Calculate Live Day and All-time Profit Metrics
router.get('/profit-summary', async (req, res) => {
  try {
    const { date } = req.query;
    let whereClause = {};

    if (date) {
      const parts = date.split('-').map(Number);
      if (parts.length === 3) {
        const start = new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
        const end = new Date(parts[0], parts[1] - 1, parts[2], 23, 59, 59, 999);
        whereClause = {
          createdAt: {
            gte: start,
            lte: end,
          },
        };
      }
    } else {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
      whereClause = {
        createdAt: {
          gte: start,
          lte: end,
        },
      };
    }

    const invoices = await prisma.invoice.findMany({
      where: whereClause,
      include: {
        items: {
          include: {
            product: true,
          },
        },
      },
    });

    let grossSales = 0;
    let grossCost = 0;
    let returnedSales = 0;
    let returnedCost = 0;
    let activeInvoicesCount = 0;
    let returnedInvoicesCount = 0;

    invoices.forEach((inv) => {
      const isRet = Boolean(inv.isReturned || inv.status === 'Returned');
      const invRev = inv.totalAmount || 0;
      let invCost = 0;

      (inv.items || []).forEach((item) => {
        const storedCost = (item.costPrice !== undefined && item.costPrice !== null && Number(item.costPrice) > 0)
          ? Number(item.costPrice)
          : (item.product ? (item.product.costPrice || (item.product.tradePrice * 0.85)) : (item.stp * 0.85));
        const q = item.quantity || 1;
        const b = item.bonus || 0;
        const totalUnits = q + b;
        const stpVal = Number(item.stp || (item.product ? item.product.tradePrice : 0)) || 0;

        let itemCostTotal = storedCost * totalUnits;
        if (b > 0 && q > 0 && totalUnits > 0 && stpVal > 0) {
          const paidRatio = q / totalUnits;
          if ((storedCost / stpVal) > (paidRatio * 1.15)) {
            itemCostTotal = storedCost * q;
          }
        }

        invCost += itemCostTotal;
      });

      if (isRet) {
        returnedSales += invRev;
        returnedCost += invCost;
        returnedInvoicesCount += 1;
      } else {
        grossSales += invRev;
        grossCost += invCost;
        activeInvoicesCount += 1;
      }
    });

    const grossProfit = grossSales - grossCost;
    const returnedProfit = returnedSales - returnedCost;
    const netSales = grossSales - returnedSales;
    const netCost = grossCost - returnedCost;
    const netProfit = grossProfit - returnedProfit;
    const profitMarginPercent = netSales > 0 ? ((netProfit / netSales) * 100).toFixed(2) : 0;

    res.json({
      invoiceCount: activeInvoicesCount,
      activeInvoicesCount,
      returnedInvoicesCount,
      totalRevenue: netSales,
      totalCost: netCost,
      netProfit,
      grossSales,
      returnedSales,
      netSales,
      grossProfit,
      returnedProfit,
      dayProfit: netProfit,
      daySales: netSales,
      profitMarginPercent,
    });
  } catch (error) {
    console.error('Error fetching profit summary:', error);
    res.status(500).json({ error: 'Failed to fetch profit summary' });
  }
});

// GET /api/invoices/:invoiceNo - Find single invoice with payment details
router.get('/:invoiceNo', async (req, res, next) => {
  try {
    const { invoiceNo } = req.params;
    const invoice = await prisma.invoice.findFirst({
      where: {
        OR: [{ invoiceNo: invoiceNo }, { id: invoiceNo }],
      },
      include: {
        customer: true,
        items: { include: { product: true } },
      },
    });

    if (!invoice) {
      const inMem = inMemoryInvoices.find((i) => i.invoiceNo === invoiceNo || i.id === invoiceNo);
      if (inMem) return res.json(inMem);
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const relatedTxs = await prisma.accountTransaction.findMany({
      where: {
        partyType: 'Customer',
        OR: [
          { voucherNo: { startsWith: `REC-POS-${invoice.invoiceNo}` } },
          { voucherNo: { startsWith: `REFUND-POS-${invoice.invoiceNo}` } },
          { referenceNo: { contains: `Inv #${invoice.invoiceNo}` } },
        ],
      },
    });

    let cashPaid = 0;
    let bankPaid = 0;
    let bankRef = '';
    let paymentMethod = 'Credit';
    let isEdited = relatedTxs.some((t) => t.voucherNo.includes('EDIT') || t.voucherNo.includes('REFUND'));

    relatedTxs.forEach((t) => {
      const m = (t.paymentMethod || '').toLowerCase();
      const isBank = m.includes('bank') || m.includes('card') || m.includes('online') || m.includes('easypaisa') || m.includes('jazzcash') || m.includes('ibft');
      const isRefund = t.transactionType === 'Expense' || t.transactionType === 'Refund';
      const amt = isRefund ? -(t.amount || 0) : (t.amount || 0);

      if (isBank) {
        bankPaid += amt;
        if (t.referenceNo) bankRef = t.referenceNo;
      } else {
        cashPaid += amt;
      }
    });

    if (cashPaid > 0 && bankPaid > 0) paymentMethod = 'Split';
    else if (bankPaid > 0) paymentMethod = 'BankTransfer';
    else if (cashPaid > 0) paymentMethod = 'Cash';

    const totalPaid = cashPaid + bankPaid;
    const balanceDue = Math.max(0, (invoice.totalAmount || 0) - totalPaid);
    const effectiveCustName = invoice.customerName || (invoice.customer ? invoice.customer.name : 'Counter Sale');
    const effectiveCustAddr = invoice.customerAddress || (invoice.customer ? invoice.customer.address : 'Local Wholesale Market');

    res.json({
      id: invoice.id,
      invoiceNo: invoice.invoiceNo,
      customerId: invoice.customerId,
      customerName: effectiveCustName,
      customerAddress: effectiveCustAddr,
      invoiceDate: invoice.invoiceDate,
      salesman: invoice.salesman,
      totalAmount: invoice.totalAmount,
      createdAt: invoice.createdAt,
      updatedAt: invoice.updatedAt,
      customer: {
        ...(invoice.customer || {}),
        id: invoice.customerId || invoice.customer?.id,
        accountNo: invoice.customer ? invoice.customer.accountNo : 1,
        name: effectiveCustName,
        address: effectiveCustAddr,
      },
      items: invoice.items || [],
      paidAmount: totalPaid,
      cashPaid,
      bankPaid,
      bankRef,
      balanceDue,
      paymentMethod,
      isEdited,
      status: invoice.status || (invoice.isReturned ? 'Returned' : 'Active'),
      isReturned: Boolean(invoice.isReturned),
      returnDate: invoice.returnDate,
      returnRefundMethod: invoice.returnRefundMethod,
      returnRefundAmount: invoice.returnRefundAmount,
      returnReason: invoice.returnReason,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/invoices - Save new wholesale invoice & decrement stock in real time
router.post('/', async (req, res, next) => {
  try {
    const { invoiceNo, customerId, customerCode, customerName, customerAddress, salesman, totalAmount, items } = req.body;
    const currentTenantUserId = req.body.userId || req.headers['x-user-id'] || null;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'At least one item is required in the invoice.' });
    }

    // 1. Resolve unique invoiceNo
    let finalInvoiceNo = String(invoiceNo || Date.now());
    const existing = await prisma.invoice.findUnique({ where: { invoiceNo: finalInvoiceNo } });
    if (existing) {
      const allInvoices = await prisma.invoice.findMany({ select: { invoiceNo: true } });
      const numericNos = allInvoices.map((i) => parseInt(i.invoiceNo, 10)).filter((n) => !isNaN(n));
      const maxNo = numericNos.length > 0 ? Math.max(...numericNos) : 3000;
      finalInvoiceNo = String(maxNo + 1);
    }

    const calculatedTotal = totalAmount !== undefined
      ? parseFloat(totalAmount)
      : items.reduce((acc, i) => acc + parseFloat(i.netAmount || i.net || '0'), 0);

    try {
      // 2. Perform Transaction: Customer setup, stock deduction, invoice creation
      const createdInvoice = await prisma.$transaction(async (tx) => {
        // Resolve customer from DB
        let targetCustomerId = null;

        // Format custom counter sale name if specified (e.g. "Mustafa (counter sale)")
        let resolvedCustName = (customerName || 'Counter Sale').trim();
        const isCounterSale = String(customerCode || req.body.customerAccNo || '1') === '1' || resolvedCustName.toLowerCase().includes('counter');
        if (isCounterSale && resolvedCustName && resolvedCustName.toLowerCase() !== 'counter sale') {
          if (!resolvedCustName.toLowerCase().includes('counter')) {
            resolvedCustName = `${resolvedCustName} (counter sale)`;
          }
        }

        if (isCounterSale) {
          // ALWAYS use Default Counter Sale Account #1 in the database — DO NOT create a new customer code!
          let defaultCounter = await tx.customer.findFirst({ where: { accountNo: 1 } });
          if (!defaultCounter) {
            defaultCounter = await tx.customer.create({
              data: {
                accountNo: 1,
                name: 'Counter Sale',
                address: customerAddress || 'Local Wholesale Market',
                contactNo: 'N/A',
              },
            });
          }
          targetCustomerId = defaultCounter.id;
        } else {
          if (customerId && typeof customerId === 'string' && customerId.length > 20) {
            const custById = await tx.customer.findUnique({ where: { id: customerId } });
            if (custById) targetCustomerId = custById.id;
          }

          const codeToTry = customerCode || req.body.customerAccNo;
          if (!targetCustomerId && codeToTry && String(codeToTry) !== '1') {
            const accNoNum = parseInt(codeToTry, 10);
            if (!isNaN(accNoNum)) {
              const custByAcc = await tx.customer.findUnique({ where: { accountNo: accNoNum } });
              if (custByAcc) targetCustomerId = custByAcc.id;
            }
          }

          if (!targetCustomerId && resolvedCustName && resolvedCustName.toLowerCase() !== 'counter sale') {
            const custByName = await tx.customer.findFirst({
              where: { name: resolvedCustName },
            });
            if (custByName) targetCustomerId = custByName.id;
          }

          if (!targetCustomerId) {
            let defaultCounter = await tx.customer.findFirst({ where: { accountNo: 1 } });
            if (!defaultCounter) {
              defaultCounter = await tx.customer.create({
                data: {
                  accountNo: 1,
                  name: 'Counter Sale',
                  address: customerAddress || 'Local Wholesale Market',
                  contactNo: 'N/A',
                },
              });
            }
            targetCustomerId = defaultCounter.id;
          }
        }

        // Process line items and decrement product stock quantity & batch stock
        const invoiceItemsData = [];
        for (const item of items) {
          let prod = null;
          const targetProdId = item.productId || item.id;
          const codeStr = String(item.code || item.productCode || '');

          if (targetProdId && typeof targetProdId === 'string' && targetProdId.length > 20) {
            prod = await tx.product.findUnique({ where: { id: targetProdId } });
          }
          if (!prod && codeStr) {
            prod = await tx.product.findFirst({ where: { productCode: codeStr } });
          }
          if (!prod && item.name) {
            prod = await tx.product.findFirst({ where: { name: item.name } });
          }

          const qtySold = parseInt(item.quantity || item.qty || '1', 10);
          const bonusSold = parseInt(item.bonus || item.bon || '0', 10);
          const qtyToDeduct = Math.max(1, qtySold + bonusSold);

          const targetBatchNo = (item.batchNo || item.batch || prod?.batchNo || 'B-101').trim();
          let parsedExpiry = item.expiryDate ? new Date(item.expiryDate) : null;
          let matchedBatch = null;

          if (prod) {
            await tx.product.update({
              where: { id: prod.id },
              data: {
                stockQuantity: { decrement: qtyToDeduct },
              },
            });

            // Deduct from specific ProductBatch
            try {
              if (item.batchId) {
                matchedBatch = await tx.productBatch.findUnique({ where: { id: item.batchId } });
              }
              if (!matchedBatch && targetBatchNo) {
                matchedBatch = await tx.productBatch.findUnique({
                  where: {
                    productId_batchNo: {
                      productId: prod.id,
                      batchNo: targetBatchNo,
                    },
                  },
                });
              }

              if (matchedBatch) {
                await tx.productBatch.update({
                  where: { id: matchedBatch.id },
                  data: {
                    quantity: { decrement: qtyToDeduct },
                  },
                });
                if (!parsedExpiry && matchedBatch.expiryDate) {
                  parsedExpiry = matchedBatch.expiryDate;
                }
              }
            } catch (bErr) {
              console.warn('Batch deduction notice:', bErr.message);
            }
          } else {
            // Auto-create product if missing to maintain data integrity
            let defaultVendor = await tx.vendor.findFirst();
            if (!defaultVendor) {
              defaultVendor = await tx.vendor.create({
                data: { vendorNo: 1, name: 'General', area: 'Main Market', contactNo: 'N/A' },
              });
            }

            prod = await tx.product.create({
              data: {
                productCode: codeStr || String(Date.now()),
                name: item.name || `Medicine ${codeStr}`,
                vendorId: defaultVendor.id,
                retailPrice: parseFloat(item.retailPrice || item.retail || '100'),
                tradePrice: parseFloat(item.stp || '85'),
                costPrice: parseFloat(item.costPrice || item.stp || '85'),
                stockQuantity: 0,
                batchNo: targetBatchNo,
              },
            });
          }

          const itemCostPrice = parseFloat(
            item.costPrice ||
            item.cost ||
            item.purchasePrice ||
            prod.costPrice ||
            (prod.tradePrice ? prod.tradePrice * (1 - (prod.extraDiscount || 0) / 100) : 0) ||
            (parseFloat(item.stp || item.price || '0') * 0.85)
          ) || 0;

          invoiceItemsData.push({
            productId: prod.id,
            batchId: matchedBatch ? matchedBatch.id : undefined,
            batchNo: targetBatchNo,
            expiryDate: parsedExpiry || (prod ? prod.expiryDate : null),
            stp: parseFloat(item.stp || item.price || '0'),
            costPrice: parseFloat(itemCostPrice.toFixed(2)),
            quantity: qtySold,
            bonus: bonusSold,
            discount: parseFloat(item.discount !== undefined ? item.discount : (item.disc ? String(item.disc).replace('%', '') : '0')),
            salesTax: parseFloat(item.salesTax || item.stax || '0'),
            netAmount: parseFloat(item.netAmount || item.net || (prod.tradePrice * qtySold)),
          });
        }

        // Resolve paid amount & payment method (Counter Sale #1 is always 100% cash paid)
        const custObj = await tx.customer.findUnique({ where: { id: targetCustomerId } });
        const isCounter = custObj && (custObj.accountNo === 1 || custObj.name.toLowerCase().includes('counter'));
        const methodUsed = req.body.paymentMethod || 'Cash';
        const totalPaidAmount = isCounter ? calculatedTotal : (req.body.paidAmount !== undefined ? parseFloat(req.body.paidAmount) : calculatedTotal);
        const cashPortion = isCounter ? calculatedTotal : (req.body.cashPaid !== undefined ? parseFloat(req.body.cashPaid) : (methodUsed === 'Cash' ? totalPaidAmount : 0));
        const bankPortion = isCounter ? 0 : (req.body.bankPaid !== undefined ? parseFloat(req.body.bankPaid) : (methodUsed === 'BankTransfer' ? totalPaidAmount : 0));
        const bankRef = req.body.bankRef || '';

        // Create Invoice Record
        const createdInvoice = await tx.invoice.create({
          data: {
            userId: currentTenantUserId,
            invoiceNo: finalInvoiceNo,
            customerId: targetCustomerId,
            customerName: resolvedCustName,
            customerAddress: customerAddress || 'Local Wholesale Market',
            invoiceDate: new Date(),
            salesman: salesman || 'Counter Cashier',
            totalAmount: calculatedTotal,
            items: {
              create: invoiceItemsData,
            },
          },
          include: { customer: true, items: { include: { product: true } } },
        });

        // Automatically record CustomerReceipt transaction in ledger if cash/bank received
        if (methodUsed === 'Split' || (cashPortion > 0 && bankPortion > 0)) {
          if (cashPortion > 0) {
            const voucherCash = `REC-POS-${finalInvoiceNo}-CASH`;
            const existingCashTx = await tx.accountTransaction.findFirst({ where: { voucherNo: voucherCash } });
            if (!existingCashTx) {
              await tx.accountTransaction.create({
                data: {
                  voucherNo: voucherCash,
                  transactionType: 'CustomerReceipt',
                  partyType: 'Customer',
                  partyId: targetCustomerId,
                  partyName: custObj ? custObj.name : resolvedCustName,
                  amount: cashPortion,
                  paymentMethod: 'Cash',
                  referenceNo: `Inv #${finalInvoiceNo} (Cash)`,
                  description: `POS Invoice #${finalInvoiceNo} Split Cash Payment`,
                },
              });
            }
          }
          if (bankPortion > 0) {
            const voucherBank = `REC-POS-${finalInvoiceNo}-BANK`;
            const existingBankTx = await tx.accountTransaction.findFirst({ where: { voucherNo: voucherBank } });
            if (!existingBankTx) {
              await tx.accountTransaction.create({
                data: {
                  voucherNo: voucherBank,
                  transactionType: 'CustomerReceipt',
                  partyType: 'Customer',
                  partyId: targetCustomerId,
                  partyName: custObj ? custObj.name : resolvedCustName,
                  amount: bankPortion,
                  paymentMethod: 'BankTransfer',
                  referenceNo: `Inv #${finalInvoiceNo}${bankRef ? ` (${bankRef})` : ''}`,
                  description: `POS Invoice #${finalInvoiceNo} Split Bank/Online Payment${bankRef ? ` [Ref: ${bankRef}]` : ''}`,
                },
              });
            }
          }
        } else if (totalPaidAmount > 0) {
          const voucherNo = `REC-POS-${finalInvoiceNo}`;
          const existingTx = await tx.accountTransaction.findFirst({ where: { voucherNo } });
          if (!existingTx) {
            const actualReceiptAmount = Math.min(totalPaidAmount, calculatedTotal);
            await tx.accountTransaction.create({
              data: {
                voucherNo,
                transactionType: 'CustomerReceipt',
                partyType: 'Customer',
                partyId: targetCustomerId,
                partyName: custObj ? custObj.name : resolvedCustName,
                amount: actualReceiptAmount,
                paymentMethod: methodUsed,
                referenceNo: `Inv #${finalInvoiceNo}${bankRef ? ` (${bankRef})` : ''}`,
                description: `POS Invoice #${finalInvoiceNo} Checkout Payment via ${methodUsed}${bankRef ? ` [Ref: ${bankRef}]` : ''}`,
              },
            });
          }
        }

        return createdInvoice;
      }, {
        maxWait: 20000,
        timeout: 60000,
      });

      console.log(`[SUCCESS] Stored Invoice #${finalInvoiceNo} in PostgreSQL & updated product stocks.`);
      return res.status(201).json(createdInvoice);
    } catch (dbErr) {
      console.warn('PostgreSQL transaction error for invoice, falling back to in-memory:', dbErr.message);
      const fallbackInvoice = {
        id: `inv-${Date.now()}`,
        invoiceNo: finalInvoiceNo,
        customerName: customerName || 'General Counter Sale',
        salesman: salesman || 'Counter Cashier',
        totalAmount: calculatedTotal,
        items,
        createdAt: new Date(),
      };
      inMemoryInvoices.unshift(fallbackInvoice);
      return res.status(201).json(fallbackInvoice);
    }
  } catch (error) {
    next(error);
  }
});

// PUT /api/invoices/:id - Update existing wholesale invoice using Reverse and Re-apply Accounting Logic
router.put('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { totalAmount, items, paidAmount, cashPaid, bankPaid, paymentMethod, bankRef } = req.body;

    const existing = await prisma.invoice.findFirst({
      where: { OR: [{ id }, { invoiceNo: String(id) }] },
      include: { customer: true, items: { include: { product: true } } },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }

    const calculatedTotal = totalAmount !== undefined
      ? parseFloat(totalAmount)
      : items ? items.reduce((acc, i) => acc + parseFloat(i.netAmount || i.net || '0'), 0) : existing.totalAmount;

    const updated = await prisma.$transaction(async (tx) => {
      // =========================================================================
      // STEP 1: REVERSAL
      // Reverse original financial impact & stock quantity of the original invoice
      // Formula: LedgerBalance = LedgerBalance - Original_Bill_Total + Original_Amount_Paid_By_Customer
      // =========================================================================

      // 1a. Reverse original product stock deductions & batch stocks
      if (Array.isArray(existing.items) && existing.items.length > 0) {
        for (const oldItem of existing.items) {
          const qtyToRestore = (oldItem.quantity || 0) + (oldItem.bonus || 0);
          if (oldItem.productId && qtyToRestore > 0) {
            await tx.product.update({
              where: { id: oldItem.productId },
              data: { stockQuantity: { increment: qtyToRestore } },
            }).catch(() => null);

            if (oldItem.batchId) {
              await tx.productBatch.update({
                where: { id: oldItem.batchId },
                data: { quantity: { increment: qtyToRestore } },
              }).catch(() => null);
            } else if (oldItem.batchNo) {
              await tx.productBatch.update({
                where: {
                  productId_batchNo: {
                    productId: oldItem.productId,
                    batchNo: oldItem.batchNo,
                  },
                },
                data: { quantity: { increment: qtyToRestore } },
              }).catch(() => null);
            }
          }
        }
        await tx.invoiceItem.deleteMany({ where: { invoiceId: existing.id } });
      }

      // 1b. Reverse original payment & refund transactions linked to this invoice
      const prevTxs = await tx.accountTransaction.findMany({
        where: {
          partyType: 'Customer',
          OR: [
            { voucherNo: { startsWith: `REC-POS-${existing.invoiceNo}` } },
            { voucherNo: { startsWith: `REFUND-POS-${existing.invoiceNo}` } },
            { referenceNo: { contains: `Inv #${existing.invoiceNo}` } },
          ],
        },
      });

      let originalPaidByCustomer = 0;
      prevTxs.forEach((t) => {
        const isRefund = t.transactionType === 'Expense' || t.transactionType === 'Refund';
        originalPaidByCustomer += isRefund ? -(t.amount || 0) : (t.amount || 0);
      });

      // Remove previous transactions to complete reversal of original invoice
      if (prevTxs.length > 0) {
        const prevTxIds = prevTxs.map((t) => t.id);
        await tx.accountTransaction.deleteMany({
          where: { id: { in: prevTxIds } },
        });
      }

      // =========================================================================
      // STEP 2: RE-APPLY
      // Re-apply new edited bill total, line items, stock deductions & payments
      // Formula: LedgerBalance = LedgerBalance + New_Edited_Bill_Total - New_Amount_Paid_By_Customer
      // =========================================================================

      // 2a. Re-apply new product line items & deduct stock and batch stock
      const newInvoiceItemsData = [];
      if (items && Array.isArray(items) && items.length > 0) {
        for (const item of items) {
          let prod = null;
          const targetProdId = item.productId || item.id;
          const codeStr = String(item.code || item.productCode || '');

          if (targetProdId && typeof targetProdId === 'string' && targetProdId.length > 20) {
            prod = await tx.product.findUnique({ where: { id: targetProdId } });
          }
          if (!prod && codeStr) {
            prod = await tx.product.findFirst({ where: { productCode: codeStr } });
          }
          if (!prod && item.name) {
            prod = await tx.product.findFirst({ where: { name: item.name } });
          }

          const qtySold = parseInt(item.quantity || item.qty || '1', 10);
          const bonusSold = parseInt(item.bonus || item.bon || '0', 10);
          const qtyToDeduct = Math.max(1, qtySold + bonusSold);

          const targetBatchNo = (item.batchNo || item.batch || prod?.batchNo || 'B-101').trim();
          let parsedExpiry = item.expiryDate ? new Date(item.expiryDate) : null;
          let matchedBatch = null;

          if (prod) {
            await tx.product.update({
              where: { id: prod.id },
              data: { stockQuantity: { decrement: qtyToDeduct } },
            });

            try {
              if (item.batchId) {
                matchedBatch = await tx.productBatch.findUnique({ where: { id: item.batchId } });
              }
              if (!matchedBatch && targetBatchNo) {
                matchedBatch = await tx.productBatch.findUnique({
                  where: {
                    productId_batchNo: {
                      productId: prod.id,
                      batchNo: targetBatchNo,
                    },
                  },
                });
              }

              if (matchedBatch) {
                await tx.productBatch.update({
                  where: { id: matchedBatch.id },
                  data: { quantity: { decrement: qtyToDeduct } },
                });
                if (!parsedExpiry && matchedBatch.expiryDate) {
                  parsedExpiry = matchedBatch.expiryDate;
                }
              }
            } catch (bErr) {
              console.warn('Batch deduction notice on edit:', bErr.message);
            }
          } else {
            let defaultVendor = await tx.vendor.findFirst();
            if (!defaultVendor) {
              defaultVendor = await tx.vendor.create({
                data: { vendorNo: 1, name: 'General', area: 'Main Market', contactNo: 'N/A' },
              });
            }

            prod = await tx.product.create({
              data: {
                productCode: codeStr || String(Date.now()),
                name: item.name || `Medicine ${codeStr}`,
                vendorId: defaultVendor.id,
                retailPrice: parseFloat(item.retailPrice || item.retail || '100'),
                tradePrice: parseFloat(item.stp || '85'),
                costPrice: parseFloat(item.costPrice || item.stp || '85'),
                stockQuantity: 0,
                batchNo: targetBatchNo,
              },
            });
          }

          const itemCostPrice = parseFloat(
            item.costPrice ||
            item.cost ||
            item.purchasePrice ||
            prod.costPrice ||
            (prod.tradePrice ? prod.tradePrice * (1 - (prod.extraDiscount || 0) / 100) : 0) ||
            (parseFloat(item.stp || item.price || '0') * 0.85)
          ) || 0;

          newInvoiceItemsData.push({
            productId: prod.id,
            batchId: matchedBatch ? matchedBatch.id : undefined,
            batchNo: targetBatchNo,
            expiryDate: parsedExpiry || (prod ? prod.expiryDate : null),
            stp: parseFloat(item.stp || item.price || '0'),
            costPrice: parseFloat(itemCostPrice.toFixed(2)),
            quantity: qtySold,
            bonus: bonusSold,
            discount: parseFloat(item.discount !== undefined ? item.discount : (item.disc ? String(item.disc).replace('%', '') : '0')),
            salesTax: parseFloat(item.salesTax || item.stax || '0'),
            netAmount: parseFloat(item.netAmount || item.net || (prod.tradePrice * qtySold)),
          });
        }
      }

      // 2b. Re-apply updated Invoice record
      const invoiceUpdateData = {
        totalAmount: calculatedTotal,
        items: { create: newInvoiceItemsData },
      };
      if (req.body.salesman) {
        invoiceUpdateData.salesman = req.body.salesman;
      }

      const updatedInv = await tx.invoice.update({
        where: { id: existing.id },
        data: invoiceUpdateData,
        include: { customer: true, items: { include: { product: true } } },
      });

      // 2c. Re-apply new payments on edited invoice
      const newPaidAmount = paidAmount !== undefined
        ? parseFloat(paidAmount)
        : originalPaidByCustomer;

      const methodUsed = paymentMethod || 'Cash';
      const custObj = existing.customer;
      const custNameStr = custObj ? custObj.name : 'Counter Sale';

      if (newPaidAmount > 0) {
        await tx.accountTransaction.create({
          data: {
            voucherNo: `REC-POS-${existing.invoiceNo}`,
            transactionType: 'CustomerReceipt',
            partyType: 'Customer',
            partyId: existing.customerId,
            partyName: custNameStr,
            amount: newPaidAmount,
            paymentMethod: methodUsed,
            referenceNo: `Inv #${existing.invoiceNo}${bankRef ? ` (${bankRef})` : ''}`,
            description: `Settled Payment for Edited Invoice #${existing.invoiceNo} via ${methodUsed}`,
          },
        });
      }

      // 2d. If original paid amount exceeded new paid amount and shop gave cash refund difference
      if (originalPaidByCustomer > newPaidAmount) {
        const cashRefundAmt = originalPaidByCustomer - newPaidAmount;
        await tx.accountTransaction.create({
          data: {
            voucherNo: `REFUND-POS-${existing.invoiceNo}-${Date.now()}`,
            transactionType: 'Expense',
            partyType: 'Customer',
            partyId: existing.customerId,
            partyName: custNameStr,
            amount: cashRefundAmt,
            paymentMethod: 'Cash',
            referenceNo: `Inv #${existing.invoiceNo} Refund`,
            description: `Cash Refund Paid from Till for Edited Invoice #${existing.invoiceNo}`,
          },
        });
      }

      return updatedInv;
    }, {
      maxWait: 20000,
      timeout: 60000,
    });

    return res.json(updated);
  } catch (error) {
    next(error);
  }
});

// POST /api/invoices/:invoiceNo/return - Execute Return on Invoice
router.post('/:invoiceNo/return', async (req, res, next) => {
  try {
    const { invoiceNo } = req.params;
    const { refundMethod, bankRef, reason, returnedBy } = req.body;

    const existing = await prisma.invoice.findFirst({
      where: {
        OR: [{ invoiceNo }, { id: invoiceNo }],
      },
      include: {
        customer: true,
        items: { include: { product: true } },
      },
    });

    if (!existing) {
      return res.status(404).json({ error: `Invoice #${invoiceNo} not found.` });
    }

    if (existing.isReturned || existing.status === 'Returned') {
      return res.status(400).json({ error: `Invoice #${invoiceNo} has already been returned.` });
    }

    const isCounterSale =
      String(existing.customer?.accountNo) === '1' ||
      (existing.customer?.name && existing.customer.name.toLowerCase().includes('counter'));

    const returnTx = await prisma.$transaction(async (tx) => {
      // 1. Restock Product Quantities & Batch Stocks
      if (Array.isArray(existing.items) && existing.items.length > 0) {
        for (const item of existing.items) {
          const qtyToRestore = parseInt(item.quantity || 1, 10) + parseInt(item.bonus || 0, 10);
          if (item.productId && qtyToRestore > 0) {
            const currentProd = await tx.product.findUnique({ where: { id: item.productId } });
            if (currentProd) {
              await tx.product.update({
                where: { id: item.productId },
                data: { stockQuantity: { increment: qtyToRestore } },
              });

              // Restore batch stock
              if (item.batchId) {
                await tx.productBatch.update({
                  where: { id: item.batchId },
                  data: { quantity: { increment: qtyToRestore } },
                }).catch(() => null);
              } else if (item.batchNo) {
                await tx.productBatch.update({
                  where: {
                    productId_batchNo: {
                      productId: item.productId,
                      batchNo: item.batchNo,
                    },
                  },
                  data: { quantity: { increment: qtyToRestore } },
                }).catch(() => null);
              }

              await tx.stockAdjustment.create({
                data: {
                  productId: item.productId,
                  adjustmentType: 'Return',
                  quantity: qtyToRestore,
                  previousStock: currentProd.stockQuantity,
                  newStock: currentProd.stockQuantity + qtyToRestore,
                  reason: `Sales Return for Invoice #${existing.invoiceNo}${reason ? `: ${reason}` : ''}`,
                  adjustedBy: returnedBy || 'Admin',
                },
              });
            }
          }
        }
      }

      // 2. Financial Refund / Payment Processing
      const custNameStr = existing.customer ? existing.customer.name : 'Counter Sale';
      let finalRefundMethod = 'AccountCredit';

      if (isCounterSale) {
        // Counter sale: user selected cash or bank refund
        const isBankRefund = (refundMethod || '').toLowerCase().includes('bank');
        finalRefundMethod = isBankRefund ? 'BankTransfer' : 'Cash';

        await tx.accountTransaction.create({
          data: {
            voucherNo: `REFUND-RET-${existing.invoiceNo}-${Date.now()}`,
            transactionType: 'Expense',
            partyType: 'Customer',
            partyId: existing.customerId,
            partyName: custNameStr,
            amount: existing.totalAmount || 0,
            paymentMethod: finalRefundMethod,
            referenceNo: `Return Inv #${existing.invoiceNo}${bankRef ? ` (${bankRef})` : ''}`,
            description: `Refund paid via ${finalRefundMethod} for Sales Return of Invoice #${existing.invoiceNo}`,
          },
        });
      } else {
        // Registered account customer:
        finalRefundMethod = refundMethod || 'AccountCredit';
        // If cash/bank refund explicitly paid out at till:
        if (finalRefundMethod === 'Cash' || finalRefundMethod === 'BankTransfer' || finalRefundMethod === 'Bank') {
          const normMethod = finalRefundMethod === 'Bank' ? 'BankTransfer' : finalRefundMethod;
          await tx.accountTransaction.create({
            data: {
              voucherNo: `REFUND-RET-${existing.invoiceNo}-${Date.now()}`,
              transactionType: 'Expense',
              partyType: 'Customer',
              partyId: existing.customerId,
              partyName: custNameStr,
              amount: existing.totalAmount || 0,
              paymentMethod: normMethod,
              referenceNo: `Return Inv #${existing.invoiceNo}${bankRef ? ` (${bankRef})` : ''}`,
              description: `Refund paid via ${normMethod} to ${custNameStr} for Sales Return of Invoice #${existing.invoiceNo}`,
            },
          });
        }
      }

      // 3. Update Invoice Status to Returned
      const returnedInvoice = await tx.invoice.update({
        where: { id: existing.id },
        data: {
          status: 'Returned',
          isReturned: true,
          returnDate: new Date(),
          returnRefundMethod: finalRefundMethod,
          returnRefundAmount: existing.totalAmount || 0,
          returnReason: reason || 'Customer Sales Return',
        },
        include: {
          customer: true,
          items: { include: { product: true } },
        },
      });

      return returnedInvoice;
    }, {
      maxWait: 20000,
      timeout: 60000,
    });

    return res.json({
      success: true,
      message: `Invoice #${existing.invoiceNo} successfully returned.`,
      invoice: returnTx,
    });
  } catch (error) {
    console.error('Error executing invoice return:', error);
    next(error);
  }
});

module.exports = router;

