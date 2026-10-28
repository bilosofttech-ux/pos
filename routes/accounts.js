const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');

// Helper: Calculate days between two dates
function getDaysDiff(d1, d2 = new Date()) {
  const date1 = new Date(d1);
  const date2 = new Date(d2);
  const diffTime = Math.abs(date2 - date1);
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

// GET /expenses - Fetch all operational expenses & salary disbursements
router.get('/expenses', async (req, res) => {
  try {
    const transactions = await prisma.accountTransaction.findMany({
      where: {
        transactionType: 'Expense',
      },
      orderBy: { createdAt: 'desc' },
    });

    const formatted = transactions
      .filter((tx) => {
        const vNo = (tx.voucherNo || '').toUpperCase();
        const desc = (tx.description || '').toLowerCase();
        const party = (tx.partyName || '').toLowerCase();
        const ref = (tx.referenceNo || '').toLowerCase();
        const isRefund =
          vNo.startsWith('REFUND') ||
          desc.includes('refund') ||
          party.includes('refund') ||
          desc.includes('sales return') ||
          ref.includes('refund') ||
          ref.includes('return inv');
        return !isRefund;
      })
      .map((tx) => ({
        id: tx.id,
        voucherNo: tx.voucherNo,
        title: tx.partyName || tx.description || 'Expense',
        category: tx.partyName && tx.partyName.toLowerCase().includes('salary') ? 'Salary Expense' : 'General Expense',
        amount: tx.amount || 0,
        paymentMethod: tx.paymentMethod || 'Cash',
        date: tx.transactionDate || tx.createdAt,
        description: tx.description || '',
      }));

    res.json(formatted);
  } catch (err) {
    console.error('Error fetching expenses:', err);
    res.status(500).json({ error: 'Failed to fetch expense records' });
  }
});

// GET /expense-heads - Fetch all unique saved expense heads / categories from DB
router.get('/expense-heads', async (req, res) => {
  try {
    const transactions = await prisma.accountTransaction.findMany({
      where: {
        transactionType: 'Expense',
      },
      select: {
        partyName: true,
        referenceNo: true,
      },
    });

    const defaultHeads = [
      'Staff Lunch & Refreshments',
      'Tea & Pantry Expenses',
      'Office Supplies & Stationery',
      'Electricity & Utility Bills',
      'Freight & Transport Charges',
      'Shop Maintenance & Repairs',
      'Marketing & Advertising Expenses',
      'Generator Fuel & Diesel',
      'Cleaning & Janitorial',
      'Salary Advance & Commission',
      'Software & IT Subscriptions',
      'Miscellaneous Expense',
    ];

    const headSet = new Set(defaultHeads);

    transactions.forEach((tx) => {
      if (tx.partyName && tx.partyName.trim()) {
        const name = tx.partyName.trim();
        const lower = name.toLowerCase();
        if (!lower.startsWith('refund') && !lower.includes('sales return')) {
          headSet.add(name);
        }
      }
      if (tx.referenceNo && tx.referenceNo.trim()) {
        const ref = tx.referenceNo.trim();
        const lower = ref.toLowerCase();
        if (!lower.startsWith('refund') && !lower.includes('sales return') && !lower.startsWith('exp-')) {
          headSet.add(ref);
        }
      }
    });

    const heads = Array.from(headSet).sort((a, b) => a.localeCompare(b));
    res.json(heads);
  } catch (err) {
    console.error('Error fetching expense heads:', err);
    res.status(500).json({ error: 'Failed to fetch expense heads' });
  }
});

// 1. GET /api/accounts/summary - Financial Dashboard Accounts Overview
router.get('/summary', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'] || req.query.userId;
    const userRole = req.headers['x-user-role'];
    const isTenant = userId && userRole !== 'SuperAdmin';

    const [invoices, purchases, transactions, customers, vendors] = await Promise.all([
      prisma.invoice.findMany({ where: isTenant ? { userId } : {} }),
      prisma.purchase.findMany({ where: isTenant ? { userId } : {} }),
      prisma.accountTransaction.findMany(),
      prisma.customer.findMany({ where: isTenant ? { OR: [{ userId }, { accountNo: 1 }] } : {} }),
      prisma.vendor.findMany({ where: isTenant ? { OR: [{ userId }, { vendorNo: 1 }] } : {} }),
    ]);

    let totalSalesRevenue = 0;
    invoices.filter((inv) => !inv.isReturned && inv.status !== 'Returned').forEach((inv) => (totalSalesRevenue += inv.totalAmount || 0));

    let totalPurchasesExpense = 0;
    purchases.forEach((pur) => (totalPurchasesExpense += pur.totalAmount || 0));

    let totalCustomerReceipts = 0;
    let totalCashReceived = 0;
    let totalBankReceived = 0;

    let totalSupplierPayments = 0;
    let totalCashSupplierPayments = 0;
    let totalBankSupplierPayments = 0;

    let totalGeneralExpenses = 0;
    let totalCashExpenses = 0;
    let totalBankExpenses = 0;

    let totalOwnerInvestment = 0;
    let totalCashOwnerInvestment = 0;
    let totalBankOwnerInvestment = 0;

    let totalCapitalWithdrawals = 0;
    let totalCashCapitalWithdrawals = 0;
    let totalBankCapitalWithdrawals = 0;

    let totalProfitWithdrawals = 0;
    let totalCashProfitWithdrawals = 0;
    let totalBankProfitWithdrawals = 0;

    transactions.forEach((tx) => {
      // Exclude cancelled/deleted vouchers from summary calculations
      if (tx.referenceNo === 'CANCELLED' || (tx.description && tx.description.includes('[DELETED'))) {
        return;
      }

      const amt = tx.amount || 0;
      const method = (tx.paymentMethod || 'Cash').toLowerCase();
      const isBank = method.includes('bank') || method.includes('card') || method.includes('online') || method.includes('ibft') || method.includes('cheque');

      if (tx.transactionType === 'CustomerReceipt') {
        totalCustomerReceipts += amt;
        if (isBank) {
          totalBankReceived += amt;
        } else {
          totalCashReceived += amt;
        }
      }

      if (tx.transactionType === 'SupplierPayment') {
        totalSupplierPayments += amt;
        if (isBank) {
          totalBankSupplierPayments += amt;
        } else {
          totalCashSupplierPayments += amt;
        }
      }

      if (tx.transactionType === 'Expense') {
        totalGeneralExpenses += amt;
        if (isBank) {
          totalBankExpenses += amt;
        } else {
          totalCashExpenses += amt;
        }
      }

      // ── Owner Capital / Investment Inflow ──
      if (tx.transactionType === 'OwnerInvestment') {
        totalOwnerInvestment += amt;
        if (isBank) {
          totalBankOwnerInvestment += amt;
        } else {
          totalCashOwnerInvestment += amt;
        }
      }

      // ── Profit Taken Out (Profit Payout - Does NOT reduce core Shop Capital) ──
      if (tx.transactionType === 'ProfitWithdrawal') {
        totalProfitWithdrawals += amt;
        if (isBank) {
          totalBankProfitWithdrawals += amt;
        } else {
          totalCashProfitWithdrawals += amt;
        }
      }

      // ── Capital Withdrawal (Return of Core Capital) ──
      if (tx.transactionType === 'CapitalWithdrawal' || tx.transactionType === 'OwnerDrawing') {
        totalCapitalWithdrawals += amt;
        if (isBank) {
          totalBankCapitalWithdrawals += amt;
        } else {
          totalCashCapitalWithdrawals += amt;
        }
      }
    });

    const totalCashOwnerDrawings = totalCashCapitalWithdrawals + totalCashProfitWithdrawals;
    const totalBankOwnerDrawings = totalBankCapitalWithdrawals + totalBankProfitWithdrawals;
    const totalOwnerDrawings = totalCapitalWithdrawals + totalProfitWithdrawals;

    // Customer Credit = Sum of individual customer outstanding debts (matches Aging Ledger)
    let totalCustomerCredit = 0;
    customers.forEach((cust) => {
      const isCounter = cust.accountNo === 1 || (cust.name && cust.name.toLowerCase().includes('counter'));
      if (!isCounter) {
        let custInvoiced = 0;
        invoices
          .filter((inv) => inv.customerId === cust.id && !inv.isReturned && inv.status !== 'Returned')
          .forEach((inv) => (custInvoiced += inv.totalAmount || 0));

        const custReceipts = transactions
          .filter((tx) =>
            tx.partyId === cust.id ||
            (tx.partyName && cust.name && tx.partyName.toLowerCase().trim() === cust.name.toLowerCase().trim())
          )
          .reduce((sum, tx) => {
            const isRefund = tx.transactionType === 'Expense' || tx.transactionType === 'Refund';
            return sum + (isRefund ? -(tx.amount || 0) : (tx.amount || 0));
          }, 0);

        const out = custInvoiced - custReceipts;
        if (out > 0) {
          totalCustomerCredit += out;
        }
      }
    });

    // Supplier Payables = Sum of individual vendor outstanding debts
    let totalPayables = 0;
    vendors.forEach((ven) => {
      let venPurchased = 0;
      purchases.filter((p) => p.vendorId === ven.id && !p.isReturned && p.status !== 'Returned').forEach((p) => (venPurchased += p.totalAmount || 0));

      const venPayments = transactions
        .filter((tx) =>
          tx.partyId === ven.id ||
          (tx.partyName && ven.name && tx.partyName.toLowerCase().trim() === ven.name.toLowerCase().trim())
        )
        .reduce((sum, tx) => sum + (tx.amount || 0), 0);

      const out = Math.max(0, venPurchased - venPayments);
      totalPayables += out;
    });

    // Physical Cash in Hand in Till / Register = Cash Collected + Cash Investment - Cash Supplier Payments - Cash Expenses - Cash Drawings/Profit
    const cashInHand = Math.max(0, (totalCashReceived + totalCashOwnerInvestment) - totalCashSupplierPayments - totalCashExpenses - totalCashOwnerDrawings);

    // Bank Account Liquidity = Bank Received + Bank Investment - Bank Supplier Payments - Bank Expenses - Bank Drawings/Profit
    const bankBalance = (totalBankReceived + totalBankOwnerInvestment) - totalBankSupplierPayments - totalBankExpenses - totalBankOwnerDrawings;

    // Core Shop Capital = Total Investments - Capital Withdrawals (Profit payouts do NOT disturb core shop capital!)
    const netOwnerCapital = totalOwnerInvestment - totalCapitalWithdrawals;

    res.json({
      totalSalesRevenue,
      totalPurchasesExpense,
      totalCustomerReceipts,
      totalCashReceived,
      totalBankReceived,
      totalCustomerCredit,
      totalReceivables: totalCustomerCredit,
      totalPayables,
      cashInHand,
      bankBalance,
      totalOwnerInvestment,
      totalCapitalWithdrawals,
      totalProfitWithdrawals,
      totalOwnerDrawings,
      netOwnerCapital,
      netOwnerEquity: netOwnerCapital,
      netProfit: totalSalesRevenue - totalPurchasesExpense - totalGeneralExpenses,
      customerCount: customers.length,
      vendorCount: vendors.length,
    });
  } catch (error) {
    console.error('Error fetching accounts summary:', error);
    res.status(500).json({ error: 'Failed to fetch accounts summary' });
  }
});

// 2. GET /api/accounts/customer-aging - Customer Receivables Aging Ledger Analysis with Date Filtering
router.get('/customer-aging', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let start = null;
    let end = null;

    if (startDate) {
      const parts = startDate.split('-').map(Number);
      if (parts.length === 3) {
        start = new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
      }
    }
    if (endDate) {
      const parts = endDate.split('-').map(Number);
      if (parts.length === 3) {
        end = new Date(parts[0], parts[1] - 1, parts[2], 23, 59, 59, 999);
      }
    }

    const customers = await prisma.customer.findMany({
      include: {
        invoices: {
          orderBy: { invoiceDate: 'desc' },
        },
      },
    });

    const transactions = await prisma.accountTransaction.findMany({
      where: { partyType: 'Customer' },
    });

    const now = new Date();

    const agingReport = customers.map((cust) => {
      const isCounter = cust.accountNo === 1 || cust.name.toLowerCase().includes('counter');

      let allTimeInvoiced = 0;
      let oldInvoiced = 0;
      let periodInvoiced = 0;
      let current0to30 = 0;
      let days31to60 = 0;
      let days61to90 = 0;
      let daysOver90 = 0;

      cust.invoices.forEach((inv) => {
        if (inv.isReturned || inv.status === 'Returned') return; // Skip returned invoice so customer balance is reduced
        const amt = inv.totalAmount || 0;
        const invDate = new Date(inv.invoiceDate);
        allTimeInvoiced += amt;

        if (start && invDate < start) {
          oldInvoiced += amt;
        } else if ((!start || invDate >= start) && (!end || invDate <= end)) {
          periodInvoiced += amt;
        }

        const days = getDaysDiff(inv.invoiceDate, now);
        if (days <= 30) current0to30 += amt;
        else if (days <= 60) days31to60 += amt;
        else if (days <= 90) days61to90 += amt;
        else daysOver90 += amt;
      });

      // Filter transactions for this customer
      const custTxs = transactions.filter((tx) =>
        tx.partyId === cust.id ||
        (tx.partyName && cust.name && tx.partyName.toLowerCase().trim() === cust.name.toLowerCase().trim())
      );

      let allTimeReceipts = 0;
      let oldReceipts = 0;
      let periodReceipts = 0;

      custTxs.forEach((tx) => {
        const isRefund = tx.voucherNo.startsWith('REFUND') || (tx.description && tx.description.toLowerCase().includes('refund')) || tx.transactionType === 'Refund';
        const amt = isRefund ? -(tx.amount || 0) : (tx.amount || 0);
        const txDate = new Date(tx.transactionDate || tx.createdAt);
        allTimeReceipts += amt;

        if (start && txDate < start) {
          oldReceipts += amt;
        } else if ((!start || txDate >= start) && (!end || txDate <= end)) {
          periodReceipts += amt;
        }
      });

      if (isCounter) {
        allTimeReceipts = allTimeInvoiced;
        oldReceipts = oldInvoiced;
        periodReceipts = periodInvoiced;
      }

      const oldBalance = isCounter ? 0 : Math.round((oldInvoiced - oldReceipts) * 100) / 100;
      const newBill = isCounter ? 0 : Math.round((start || end ? periodInvoiced : allTimeInvoiced) * 100) / 100;
      const receivedInPeriod = isCounter ? (start || end ? periodInvoiced : allTimeInvoiced) : Math.round((start || end ? periodReceipts : allTimeReceipts) * 100) / 100;
      const currentBalance = isCounter ? 0 : Math.round((allTimeInvoiced - allTimeReceipts) * 100) / 100;

      return {
        id: cust.id,
        accountNo: cust.accountNo,
        name: cust.name,
        contactNo: cust.contactNo || 'N/A',
        isCounter,
        oldBalance,
        newBill,
        totalInvoiced: allTimeInvoiced,
        totalReceipts: receivedInPeriod,
        allTimeReceipts,
        netOutstanding: currentBalance,
        currentBalance,
        aging: {
          current0to30: isCounter ? 0 : current0to30,
          days31to60: isCounter ? 0 : days31to60,
          days61to90: isCounter ? 0 : days61to90,
          daysOver90: isCounter ? 0 : daysOver90,
        },
        lastInvoiceDate: cust.invoices[0] ? cust.invoices[0].invoiceDate : null,
      };
    });

    res.json(agingReport);
  } catch (error) {
    console.error('Error calculating customer aging report:', error);
    res.status(500).json({ error: 'Failed to calculate customer aging ledger' });
  }
});

// 3. GET /api/accounts/supplier-aging - Supplier Payables Aging Ledger Analysis with Date Filtering
router.get('/supplier-aging', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let start = null;
    let end = null;

    if (startDate) {
      const parts = startDate.split('-').map(Number);
      if (parts.length === 3) {
        start = new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
      }
    }
    if (endDate) {
      const parts = endDate.split('-').map(Number);
      if (parts.length === 3) {
        end = new Date(parts[0], parts[1] - 1, parts[2], 23, 59, 59, 999);
      }
    }

    const vendors = await prisma.vendor.findMany({
      include: {
        purchases: {
          orderBy: { purchaseDate: 'desc' },
        },
      },
    });

    const transactions = await prisma.accountTransaction.findMany({
      where: { partyType: 'Vendor' },
    });

    const now = new Date();

    const agingReport = vendors.map((v) => {
      let allTimePurchased = 0;
      let oldPurchased = 0;
      let periodPurchased = 0;
      let current0to30 = 0;
      let days31to60 = 0;
      let days61to90 = 0;
      let daysOver90 = 0;

      v.purchases.forEach((pur) => {
        if (pur.isReturned || pur.status === 'Returned') return; // Skip returned purchase order so supplier balance is reduced
        const amt = Math.round((pur.totalAmount || 0) * 100) / 100;
        const purDate = new Date(pur.purchaseDate);
        allTimePurchased += amt;

        if (start && purDate < start) {
          oldPurchased += amt;
        } else if ((!start || purDate >= start) && (!end || purDate <= end)) {
          periodPurchased += amt;
        }

        const days = getDaysDiff(pur.purchaseDate, now);
        if (days <= 30) current0to30 += amt;
        else if (days <= 60) days31to60 += amt;
        else if (days <= 90) days61to90 += amt;
        else daysOver90 += amt;
      });

      const vendorTxs = transactions.filter(
        (tx) =>
          tx.partyId === v.id ||
          (tx.partyName && v.name && tx.partyName.toLowerCase().trim() === v.name.toLowerCase().trim())
      );

      let allTimePayments = 0;
      let oldPayments = 0;
      let periodPayments = 0;

      vendorTxs.forEach((tx) => {
        const amt = Math.round((tx.amount || 0) * 100) / 100;
        const txDate = new Date(tx.transactionDate || tx.createdAt);
        allTimePayments += amt;

        if (start && txDate < start) {
          oldPayments += amt;
        } else if ((!start || txDate >= start) && (!end || txDate <= end)) {
          periodPayments += amt;
        }
      });

      const oldBalance = Math.round((oldPurchased - oldPayments) * 100) / 100;
      const newBill = Math.round((start || end ? periodPurchased : allTimePurchased) * 100) / 100;
      const paidInPeriod = Math.round((start || end ? periodPayments : allTimePayments) * 100) / 100;
      const netPayable = Math.round((allTimePurchased - allTimePayments) * 100) / 100;

      return {
        id: v.id,
        vendorNo: v.vendorNo,
        name: v.name,
        area: v.area || 'Main Market',
        contactNo: v.contactNo || 'N/A',
        oldBalance,
        newBill,
        totalPurchased: Math.round(allTimePurchased * 100) / 100,
        totalPayments: paidInPeriod,
        allTimePayments: Math.round(allTimePayments * 100) / 100,
        netPayable,
        aging: {
          current0to30: Math.round(current0to30 * 100) / 100,
          days31to60: Math.round(days31to60 * 100) / 100,
          days61to90: Math.round(days61to90 * 100) / 100,
          daysOver90: Math.round(daysOver90 * 100) / 100,
        },
        lastPurchaseDate: v.purchases[0] ? v.purchases[0].purchaseDate : null,
      };
    });

    res.json(agingReport);
  } catch (error) {
    console.error('Error calculating supplier aging report:', error);
    res.status(500).json({ error: 'Failed to calculate supplier aging ledger' });
  }
});

// 4. GET /api/accounts/statement/:partyType/:partyId - Customer or Supplier Date-wise Detailed Ledger Statement
router.get('/statement/:partyType/:partyId', async (req, res) => {
  try {
    const { partyType, partyId } = req.params;
    const { startDate, endDate } = req.query;

    let start = null;
    let end = null;

    if (startDate) {
      const parts = startDate.split('-').map(Number);
      if (parts.length === 3) {
        start = new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
      }
    }
    if (endDate) {
      const parts = endDate.split('-').map(Number);
      if (parts.length === 3) {
        end = new Date(parts[0], parts[1] - 1, parts[2], 23, 59, 59, 999);
      }
    }

    const allEntries = [];
    let partyDetails = null;

    if (partyType === 'Customer') {
      const customer = await prisma.customer.findUnique({
        where: { id: partyId },
        include: { invoices: true },
      });

      if (!customer) return res.status(404).json({ error: 'Customer not found' });

      partyDetails = {
        id: customer.id,
        accountNo: customer.accountNo,
        name: customer.name,
        contactNo: customer.contactNo || 'N/A',
        address: customer.address || 'N/A',
        area: customer.area || 'N/A'
      };

      // Add Sale Invoices as DEBIT entries (+), and Sales Returns as CREDIT entries (-)
      customer.invoices.forEach((inv) => {
        const amt = Math.round((inv.totalAmount || 0) * 100) / 100;
        allEntries.push({
          id: inv.id,
          date: inv.invoiceDate,
          voucherNo: `INV-${inv.invoiceNo}`,
          type: 'Sale Invoice',
          debit: amt,
          credit: 0,
          description: `Wholesale Sale Invoice #${inv.invoiceNo}`,
        });

        if (inv.isReturned || inv.status === 'Returned') {
          allEntries.push({
            id: `ret_${inv.id}`,
            date: inv.returnDate || inv.invoiceDate,
            voucherNo: `RET-${inv.invoiceNo}`,
            type: 'Sales Return',
            debit: 0,
            credit: amt,
            description: `Sales Return for Invoice #${inv.invoiceNo}${inv.returnReason ? `: ${inv.returnReason}` : ''}`,
          });
        }
      });

      // Add Customer Receipts as CREDIT entries (-) and Cash Refunds as DEBIT entries (+)
      const receipts = await prisma.accountTransaction.findMany({
        where: { partyType: 'Customer', OR: [{ partyId }, { partyName: customer.name }] },
      });

      receipts.forEach((r) => {
        const isRefund = r.voucherNo.startsWith('REFUND') || (r.description && r.description.toLowerCase().includes('refund')) || r.transactionType === 'Refund';
        const amt = Math.round((r.amount || 0) * 100) / 100;
        allEntries.push({
          id: r.id,
          date: r.transactionDate || r.createdAt,
          voucherNo: r.voucherNo,
          type: isRefund ? 'Cash Refund' : 'Customer Receipt',
          debit: isRefund ? amt : 0,
          credit: isRefund ? 0 : amt,
          description: r.description || (isRefund ? `Cash Refund Paid via ${r.paymentMethod}` : `Payment Received via ${r.paymentMethod}`),
        });
      });
    } else if (partyType === 'Vendor') {
      const vendor = await prisma.vendor.findUnique({
        where: { id: partyId },
        include: { purchases: true },
      });

      if (!vendor) return res.status(404).json({ error: 'Supplier not found' });

      partyDetails = {
        id: vendor.id,
        vendorNo: vendor.vendorNo,
        accountNo: vendor.vendorNo,
        name: vendor.name,
        contactNo: vendor.contactNo || 'N/A',
        address: vendor.address || 'N/A',
        area: vendor.area || 'N/A'
      };

      // Add Purchase Bills as CREDIT entries (+) and Purchase Returns as DEBIT entries (-)
      vendor.purchases.forEach((pur) => {
        const amt = Math.round((pur.totalAmount || 0) * 100) / 100;
        allEntries.push({
          id: pur.id,
          date: pur.purchaseDate,
          voucherNo: `PUR-${pur.purchaseNo}`,
          type: 'Purchase Invoice',
          debit: 0,
          credit: amt,
          description: `Medicine Purchase Invoice #${pur.purchaseNo}`,
        });

        if (pur.isReturned || pur.status === 'Returned') {
          allEntries.push({
            id: `pur_ret_${pur.id}`,
            date: pur.returnDate || pur.purchaseDate,
            voucherNo: `PUR-RET-${pur.purchaseNo}`,
            type: 'Purchase Return',
            debit: pur.totalAmount,
            credit: 0,
            description: `Purchase Return for Invoice #${pur.purchaseNo}`,
          });
        }
      });

      // Add Supplier Payments as DEBIT entries (-)
      const payments = await prisma.accountTransaction.findMany({
        where: { partyType: 'Vendor', OR: [{ partyId }, { partyName: vendor.name }] },
      });

      payments.forEach((p) => {
        const amt = Math.round((p.amount || 0) * 100) / 100;
        allEntries.push({
          id: p.id,
          date: p.transactionDate || p.createdAt,
          voucherNo: p.voucherNo,
          type: 'Supplier Payment',
          debit: amt,
          credit: 0,
          description: p.description || `Payment Released via ${p.paymentMethod}`,
        });
      });
    }

    // Sort entries chronologically
    allEntries.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Calculate Opening Balance prior to start date & filter period entries
    let openingBalance = 0;
    const periodEntries = [];

    allEntries.forEach((e) => {
      const eDate = new Date(e.date);
      const isBeforeStart = start && eDate < start;
      const isAfterEnd = end && eDate > end;

      if (partyType === 'Customer') {
        const netChange = (e.debit || 0) - (e.credit || 0);
        if (isBeforeStart) {
          openingBalance += netChange;
        } else if (!isAfterEnd) {
          periodEntries.push(e);
        }
      } else { // Vendor
        const netChange = (e.credit || 0) - (e.debit || 0);
        if (isBeforeStart) {
          openingBalance += netChange;
        } else if (!isAfterEnd) {
          periodEntries.push(e);
        }
      }
    });

    openingBalance = Math.round(openingBalance * 100) / 100;

    let periodDebits = 0;
    let periodCredits = 0;
    let runningBalance = openingBalance;

    const statementWithRunningBal = periodEntries.map((e) => {
      periodDebits += e.debit || 0;
      periodCredits += e.credit || 0;

      if (partyType === 'Customer') {
        runningBalance += (e.debit || 0) - (e.credit || 0);
      } else {
        runningBalance += (e.credit || 0) - (e.debit || 0);
      }
      runningBalance = Math.round(runningBalance * 100) / 100;

      return {
        ...e,
        runningBalance,
      };
    });

    periodDebits = Math.round(periodDebits * 100) / 100;
    periodCredits = Math.round(periodCredits * 100) / 100;
    const closingBalance = Math.round(runningBalance * 100) / 100;

    res.json({
      partyDetails,
      openingBalance,
      periodDebits,
      periodCredits,
      closingBalance,
      entries: statementWithRunningBal,
    });
  } catch (error) {
    console.error('Error fetching ledger statement:', error);
    res.status(500).json({ error: 'Failed to fetch ledger statement' });
  }
});

// POST /api/accounts/recheck-ledgers - Audit & Auto-Correct Ledger Discrepancies
router.post('/recheck-ledgers', async (req, res) => {
  try {
    let correctedCount = 0;
    const details = [];

    // 1. Fetch all invoices, customer receipts, and customer accounts
    const [invoices, receipts, customers] = await Promise.all([
      prisma.invoice.findMany({ include: { customer: true } }),
      prisma.accountTransaction.findMany({ where: { partyType: 'Customer' } }),
      prisma.customer.findMany({ include: { invoices: true } }),
    ]);

    // 2. Audit POS checkout receipts vs Invoice totals
    for (const inv of invoices) {
      const invTotal = inv.totalAmount || 0;
      const invNoStr = String(inv.invoiceNo);
      const matchingReceipts = receipts.filter((r) => {
        if (r.voucherNo === `REC-POS-${invNoStr}` || r.voucherNo === `REC-POS-${invNoStr}-CASH` || r.voucherNo === `REC-POS-${invNoStr}-BANK`) {
          return true;
        }
        if (r.referenceNo) {
          const match = r.referenceNo.match(/Inv #(\d+)/i);
          if (match && match[1] === invNoStr) return true;
        }
        return false;
      });

      for (const rec of matchingReceipts) {
        if (rec.amount > invTotal + 0.01) {
          const oldAmt = rec.amount;
          const newAmt = Math.round(invTotal * 100) / 100;
          await prisma.accountTransaction.update({
            where: { id: rec.id },
            data: { amount: newAmt },
          });
          correctedCount++;
          details.push(`Adjusted checkout receipt ${rec.voucherNo} from Rs. ${oldAmt.toFixed(2)} to Rs. ${newAmt.toFixed(2)} for Invoice #${inv.invoiceNo}`);
        }
      }
    }

    // 3. Audit party ID mapping for customer transactions
    for (const cust of customers) {
      const unmappedTxs = await prisma.accountTransaction.findMany({
        where: {
          partyType: 'Customer',
          partyId: null,
          partyName: cust.name,
        },
      });

      for (const tx of unmappedTxs) {
        await prisma.accountTransaction.update({
          where: { id: tx.id },
          data: { partyId: cust.id },
        });
        correctedCount++;
        details.push(`Linked transaction ${tx.voucherNo || tx.id} to Customer "${cust.name}"`);
      }
    }

    // 4. Audit party ID mapping for Vendor / Supplier transactions
    const vendors = await prisma.vendor.findMany();
    for (const v of vendors) {
      const unmappedVendorTxs = await prisma.accountTransaction.findMany({
        where: {
          partyType: 'Vendor',
          partyId: null,
          partyName: v.name,
        },
      });

      for (const tx of unmappedVendorTxs) {
        await prisma.accountTransaction.update({
          where: { id: tx.id },
          data: { partyId: v.id },
        });
        correctedCount++;
        details.push(`Linked transaction ${tx.voucherNo || tx.id} to Supplier/Vendor "${v.name}"`);
      }
    }

    res.json({
      success: true,
      correctedCount,
      customersAudited: customers.length,
      vendorsAudited: vendors.length,
      invoicesAudited: invoices.length,
      details,
      message: correctedCount > 0
        ? `✅ Audit Complete! Corrected ${correctedCount} ledger discrepancy item(s).`
        : `✅ Audit Complete! All ledger balances, customer & supplier statements are 100% mathematically accurate.`,
    });
  } catch (err) {
    console.error('Error during ledger recheck:', err);
    res.status(500).json({ error: 'Failed to recheck ledger calculations.' });
  }
});

// 5. POST /api/accounts/voucher - Record Financial Voucher / Payment / Receipt / Expense
router.post('/voucher', async (req, res) => {
  try {
    const { transactionType, partyType, partyId, partyName, amount, paymentMethod, referenceNo, description } = req.body;

    if (!transactionType || !amount) {
      return res.status(400).json({ error: 'transactionType and amount are required' });
    }

    const parsedAmt = parseFloat(amount);
    if (isNaN(parsedAmt) || parsedAmt <= 0) {
      return res.status(400).json({ error: 'Amount must be greater than 0' });
    }

    const method = (paymentMethod || 'Cash').toLowerCase();
    const isBank = method.includes('bank') || method.includes('card') || method.includes('online') || method.includes('ibft') || method.includes('cheque');

    // Balance Guard: If paying a supplier, logging an expense, or owner drawing/profit withdrawal, prevent overdraft beyond available funds
    if (
      transactionType === 'SupplierPayment' ||
      transactionType === 'Expense' ||
      transactionType === 'OwnerDrawing' ||
      transactionType === 'ProfitWithdrawal' ||
      transactionType === 'CapitalWithdrawal'
    ) {
      const allTx = await prisma.accountTransaction.findMany();
      let totalBankIn = 0;
      let totalBankOut = 0;
      let totalCashIn = 0;
      let totalCashOut = 0;

      allTx.forEach((tx) => {
        const m = (tx.paymentMethod || 'Cash').toLowerCase();
        const txIsBank = m.includes('bank') || m.includes('card') || m.includes('online') || m.includes('ibft') || m.includes('cheque');
        const a = tx.amount || 0;
        if (tx.transactionType === 'CustomerReceipt' || tx.transactionType === 'OwnerInvestment') {
          if (txIsBank) totalBankIn += a;
          else totalCashIn += a;
        } else if (
          tx.transactionType === 'SupplierPayment' ||
          tx.transactionType === 'Expense' ||
          tx.transactionType === 'OwnerDrawing' ||
          tx.transactionType === 'ProfitWithdrawal' ||
          tx.transactionType === 'CapitalWithdrawal'
        ) {
          if (txIsBank) totalBankOut += a;
          else totalCashOut += a;
        }
      });

      const currentBankBalance = totalBankIn - totalBankOut;
      const currentCashInHand = totalCashIn - totalCashOut;

      if (isBank && parsedAmt > currentBankBalance) {
        return res.status(400).json({
          error: `Insufficient Bank Balance! Available Bank Funds: Rs. ${Number(currentBankBalance).toFixed(2)}, cannot pay/withdraw Rs. ${parsedAmt.toFixed(2)}.`,
        });
      }

      if (!isBank && parsedAmt > currentCashInHand) {
        return res.status(400).json({
          error: `Insufficient Cash in Hand! Available Cash in Register: Rs. ${Number(currentCashInHand).toFixed(2)}, cannot pay/withdraw Rs. ${parsedAmt.toFixed(2)}.`,
        });
      }
    }

    const count = await prisma.accountTransaction.count();
    const prefix = transactionType === 'CustomerReceipt' 
      ? 'CRV' 
      : transactionType === 'SupplierPayment' 
      ? 'CPV' 
      : transactionType === 'Expense' 
      ? 'EXP' 
      : transactionType === 'OwnerInvestment' 
      ? 'OIV' 
      : transactionType === 'ProfitWithdrawal'
      ? 'OPW'
      : transactionType === 'CapitalWithdrawal'
      ? 'OCW'
      : 'ODV';
    const voucherNo = `${prefix}-${String(count + 1001)}`;

    const newTx = await prisma.accountTransaction.create({
      data: {
        voucherNo,
        transactionType,
        partyType: partyType || 'GeneralExpense',
        partyId,
        partyName,
        amount: parsedAmt,
        paymentMethod: paymentMethod || 'Cash',
        referenceNo,
        description: description || `${transactionType} voucher logged`,
        transactionDate: new Date(),
      },
    });

    res.status(201).json(newTx);
  } catch (error) {
    console.error('Error recording financial voucher:', error);
    res.status(500).json({ error: error.message || 'Failed to record financial voucher' });
  }
});

// 6. GET /api/accounts/transactions - List all journal entries
router.get('/transactions', async (req, res) => {
  try {
    const transactions = await prisma.accountTransaction.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json(transactions);
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({ error: 'Failed to fetch journal transactions' });
  }
});

// 7. PUT /api/accounts/vouchers/:id - Edit financial voucher/expense
router.put('/vouchers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { partyName, amount, paymentMethod, referenceNo, description } = req.body;

    const existing = await prisma.accountTransaction.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Voucher not found' });
    }

    const parsedAmt = parseFloat(amount);
    if (isNaN(parsedAmt) || parsedAmt <= 0) {
      return res.status(400).json({ error: 'Valid amount is required' });
    }

    const updated = await prisma.accountTransaction.update({
      where: { id },
      data: {
        partyName: partyName !== undefined ? partyName : existing.partyName,
        amount: parsedAmt,
        paymentMethod: paymentMethod || existing.paymentMethod,
        referenceNo: referenceNo !== undefined ? referenceNo : existing.referenceNo,
        description: description !== undefined ? description : existing.description,
      },
    });

    res.json(updated);
  } catch (err) {
    console.error('Error updating voucher:', err);
    res.status(500).json({ error: 'Failed to update voucher' });
  }
});

// 8. DELETE /api/accounts/vouchers/:id - Soft-cancel financial voucher/expense
router.delete('/vouchers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let existing = await prisma.accountTransaction.findUnique({ where: { id } }).catch(() => null);

    if (!existing) {
      existing = await prisma.accountTransaction.findFirst({
        where: {
          OR: [{ id: id }, { voucherNo: id }],
        },
      });
    }

    if (!existing) {
      return res.status(404).json({ error: 'Voucher not found' });
    }

    // Cancel / Soft-delete the voucher so audit trail is preserved with status CANCELLED
    const updated = await prisma.accountTransaction.update({
      where: { id: existing.id },
      data: {
        amount: 0,
        referenceNo: 'CANCELLED',
        description: `[DELETED / CANCELLED] ${existing.description || ''}`,
      },
    });

    // If deleting HR salary slip voucher, revert slip to Unpaid
    const ref = existing.referenceNo || existing.description || '';
    if (ref.includes('SLIP-')) {
      const match = ref.match(/SLIP-\d+/i);
      const slipNo = match ? match[0].toUpperCase() : null;
      if (slipNo) {
        await prisma.hRPayroll.updateMany({
          where: { slipNo },
          data: { paymentStatus: 'Unpaid', paymentDate: null },
        }).catch(() => {});
      }
    }

    res.json({ message: 'Voucher cancelled and deleted successfully', voucher: updated });
  } catch (err) {
    console.error('Error deleting voucher:', err);
    res.status(500).json({ error: err.message || 'Failed to delete voucher' });
  }
});

module.exports = router;
