const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');

// Helper: Compute live dynamic asset valuation & depreciation timeline
function computeAssetValuation(asset) {
  const purchaseDate = new Date(asset.purchaseDate || asset.createdAt || Date.now());
  const now = new Date();
  
  const purchaseCost = parseFloat(asset.purchaseCost) || 0;
  const usefulLifeYears = parseFloat(asset.usefulLifeYears) || 5;
  const salvageValue = parseFloat(asset.salvageValue) || 0;
  
  // Calculate annual depreciation
  let annualDep = parseFloat(asset.annualDepreciation) || 0;
  if (annualDep <= 0 && usefulLifeYears > 0) {
    annualDep = Math.max(0, (purchaseCost - salvageValue) / usefulLifeYears);
  }
  
  const monthlyDep = annualDep / 12;
  const dailyDep = annualDep / 365.25;

  // Elapsed time calculation
  const diffMs = Math.max(0, now.getTime() - purchaseDate.getTime());
  const ageDays = diffMs / (1000 * 60 * 60 * 24);
  const ageYears = ageDays / 365.25;
  const ageMonths = ageDays / 30.4375;

  // Accumulated depreciation to date
  const maxDepreciable = Math.max(0, purchaseCost - salvageValue);
  const accumulatedDepreciation = Math.min(maxDepreciable, ageDays * dailyDep);
  
  // Current expected value right now
  const currentValueRightNow = Math.max(salvageValue, purchaseCost - accumulatedDepreciation);

  // Year-by-year depreciation progression timeline
  const purchaseYear = purchaseDate.getFullYear();
  const currentYear = now.getFullYear();
  const timelineYearsCount = Math.max(Math.ceil(usefulLifeYears) + 1, (currentYear - purchaseYear) + 3);
  
  const yearlyTimeline = [];
  let runningBookValue = purchaseCost;

  for (let i = 0; i < timelineYearsCount; i++) {
    const yr = purchaseYear + i;
    const openingVal = runningBookValue;
    
    // In final year or if depleted, cap depreciation
    const depThisYear = Math.min(annualDep, Math.max(0, openingVal - salvageValue));
    const closingVal = Math.max(salvageValue, openingVal - depThisYear);
    runningBookValue = closingVal;

    yearlyTimeline.push({
      year: yr,
      yearLabel: `Year ${i + 1} (${yr})`,
      openingValue: Math.round(openingVal * 100) / 100,
      depreciationAmount: Math.round(depThisYear * 100) / 100,
      closingValue: Math.round(closingVal * 100) / 100,
      isCurrentYear: yr === currentYear,
      isPast: yr < currentYear,
      isFuture: yr > currentYear,
    });

    if (closingVal <= salvageValue && yr >= currentYear) {
      break;
    }
  }

  return {
    ...asset,
    purchaseDateFormatted: purchaseDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
    purchaseYear,
    ageYears: Math.round(ageYears * 10) / 10,
    ageMonths: Math.round(ageMonths * 10) / 10,
    ageFormatted: `${Math.floor(ageYears)}y ${Math.floor(ageMonths % 12)}m (${Math.floor(ageDays)} days)`,
    annualDepreciation: Math.round(annualDep * 100) / 100,
    monthlyDepreciation: Math.round(monthlyDep * 100) / 100,
    dailyDepreciation: Math.round(dailyDep * 100) / 100,
    accumulatedDepreciation: Math.round(accumulatedDepreciation * 100) / 100,
    currentValueRightNow: Math.round(currentValueRightNow * 100) / 100,
    depreciationPercent: purchaseCost > 0 ? Math.round((accumulatedDepreciation / purchaseCost) * 1000) / 10 : 0,
    remainingPercent: purchaseCost > 0 ? Math.round((currentValueRightNow / purchaseCost) * 1000) / 10 : 0,
    yearlyTimeline,
  };
}

// 1. GET /api/assets - Retrieve all fixed assets with live calculated valuations
router.get('/', async (req, res) => {
  try {
    const assets = await prisma.fixedAsset.findMany({
      orderBy: { createdAt: 'desc' },
      include: { depreciations: true },
    });

    const evaluated = assets.map(computeAssetValuation);
    res.json(evaluated);
  } catch (err) {
    console.error('Error fetching fixed assets:', err);
    res.status(500).json({ error: 'Failed to fetch fixed assets list' });
  }
});

// 2. GET /api/assets/business-net-worth - Comprehensive Business Valuation & Net Worth Engine
router.get('/business-net-worth', async (req, res) => {
  try {
    const [assets, products, transactions, customers, vendors] = await Promise.all([
      prisma.fixedAsset.findMany(),
      prisma.product.findMany({ select: { stockQuantity: true, purchasePrice: true, tradePrice: true } }),
      prisma.accountTransaction.findMany(),
      prisma.customer.findMany({ include: { invoices: true } }),
      prisma.vendor.findMany({ include: { purchases: true } }),
    ]);

    // 1. Fixed Assets Valuation
    let totalFixedAssetsOriginalCost = 0;
    let totalFixedAssetsCurrentValue = 0;
    let totalAccumulatedDepreciation = 0;

    const categoryBreakdown = {};

    assets.forEach((a) => {
      if (a.status !== 'Disposed' && a.status !== 'Sold') {
        const val = computeAssetValuation(a);
        totalFixedAssetsOriginalCost += val.purchaseCost;
        totalFixedAssetsCurrentValue += val.currentValueRightNow;
        totalAccumulatedDepreciation += val.accumulatedDepreciation;

        const cat = a.category || 'Other Equipment';
        if (!categoryBreakdown[cat]) {
          categoryBreakdown[cat] = {
            category: cat,
            count: 0,
            originalCost: 0,
            currentValue: 0,
            depreciation: 0,
          };
        }
        categoryBreakdown[cat].count += 1;
        categoryBreakdown[cat].originalCost += val.purchaseCost;
        categoryBreakdown[cat].currentValue += val.currentValueRightNow;
        categoryBreakdown[cat].depreciation += val.accumulatedDepreciation;
      }
    });

    // 2. Stock Inventory Valuation (At Purchase Cost & Market Trade Price)
    let totalInventoryCostValue = 0;
    let totalInventoryRetailValue = 0;
    let totalStockUnits = 0;

    products.forEach((p) => {
      const qty = Math.max(0, p.stockQuantity || 0);
      const cost = p.purchasePrice || 0;
      const trade = p.tradePrice || cost;
      totalInventoryCostValue += qty * cost;
      totalInventoryRetailValue += qty * trade;
      totalStockUnits += qty;
    });

    // 3. Liquid Cash & Bank Balances
    let totalBankIn = 0, totalBankOut = 0;
    let totalCashIn = 0, totalCashOut = 0;

    transactions.forEach((tx) => {
      if (tx.referenceNo === 'CANCELLED' || (tx.description && tx.description.includes('[DELETED'))) return;
      const amt = tx.amount || 0;
      const m = (tx.paymentMethod || 'Cash').toLowerCase();
      const isBank = m.includes('bank') || m.includes('card') || m.includes('online') || m.includes('ibft') || m.includes('cheque');

      if (tx.transactionType === 'CustomerReceipt' || tx.transactionType === 'OwnerInvestment') {
        if (isBank) totalBankIn += amt;
        else totalCashIn += amt;
      } else if (
        tx.transactionType === 'SupplierPayment' ||
        tx.transactionType === 'Expense' ||
        tx.transactionType === 'OwnerDrawing' ||
        tx.transactionType === 'ProfitWithdrawal' ||
        tx.transactionType === 'CapitalWithdrawal'
      ) {
        if (isBank) totalBankOut += amt;
        else totalCashOut += amt;
      }
    });

    const cashInHand = Math.round((totalCashIn - totalCashOut) * 100) / 100;
    const bankBalance = Math.round((totalBankIn - totalBankOut) * 100) / 100;
    const totalLiquidFunds = Math.round((cashInHand + bankBalance) * 100) / 100;

    // 4. Market Credit Receivables (Customer Debts)
    let totalCustomerReceivables = 0;
    customers.forEach((cust) => {
      const isCounter = cust.accountNo === 1 || (cust.name && cust.name.toLowerCase().includes('counter'));
      if (!isCounter) {
        let custInvoiced = 0;
        (cust.invoices || []).forEach((inv) => {
          if (!inv.isReturned && inv.status !== 'Returned') custInvoiced += inv.totalAmount || 0;
        });

        const custReceipts = transactions
          .filter((tx) => tx.partyId === cust.id || (tx.partyName && tx.partyName.toLowerCase().trim() === cust.name.toLowerCase().trim()))
          .reduce((sum, tx) => {
            const isRefund = tx.transactionType === 'Expense' || tx.transactionType === 'Refund';
            return sum + (isRefund ? -(tx.amount || 0) : (tx.amount || 0));
          }, 0);

        const out = custInvoiced - custReceipts;
        if (out > 0) totalCustomerReceivables += out;
      }
    });

    // 5. Supplier Payables (Vendor Debts)
    let totalSupplierPayables = 0;
    vendors.forEach((v) => {
      let vPurchased = 0;
      (v.purchases || []).forEach((pur) => {
        if (!pur.isReturned && pur.status !== 'Returned') vPurchased += pur.totalAmount || 0;
      });

      const vPayments = transactions
        .filter((tx) => (tx.partyType === 'Vendor' || tx.transactionType === 'SupplierPayment') && (tx.partyId === v.id || (tx.partyName && tx.partyName.toLowerCase().trim() === v.name.toLowerCase().trim())))
        .reduce((sum, tx) => sum + (tx.amount || 0), 0);

      const out = vPurchased - vPayments;
      if (out > 0) totalSupplierPayables += out;
    });

    // TOTAL BUSINESS NET WORTH / VALUATION
    const totalCurrentAssets = totalLiquidFunds + totalInventoryCostValue + totalCustomerReceivables;
    const totalAssetsWithFixed = totalCurrentAssets + totalFixedAssetsCurrentValue;
    const totalLiabilities = totalSupplierPayables;
    const totalBusinessNetWorth = totalAssetsWithFixed - totalLiabilities;

    res.json({
      valuationDate: new Date(),
      totalBusinessNetWorth: Math.round(totalBusinessNetWorth * 100) / 100,
      totalAssetsWithFixed: Math.round(totalAssetsWithFixed * 100) / 100,
      totalCurrentAssets: Math.round(totalCurrentAssets * 100) / 100,
      totalLiabilities: Math.round(totalLiabilities * 100) / 100,
      fixedAssets: {
        totalAssetsCount: assets.length,
        originalCost: Math.round(totalFixedAssetsOriginalCost * 100) / 100,
        currentExpectedValueRightNow: Math.round(totalFixedAssetsCurrentValue * 100) / 100,
        accumulatedDepreciation: Math.round(totalAccumulatedDepreciation * 100) / 100,
        categories: Object.values(categoryBreakdown),
      },
      currentAssetsBreakdown: {
        cashInHand,
        bankBalance,
        totalLiquidFunds,
        inventoryCostValue: Math.round(totalInventoryCostValue * 100) / 100,
        inventoryRetailValue: Math.round(totalInventoryRetailValue * 100) / 100,
        totalStockUnits,
        customerReceivables: Math.round(totalCustomerReceivables * 100) / 100,
      },
      liabilitiesBreakdown: {
        supplierPayables: Math.round(totalSupplierPayables * 100) / 100,
      },
    });
  } catch (err) {
    console.error('Error computing business net worth:', err);
    res.status(500).json({ error: 'Failed to compute total business net worth' });
  }
});

// 3. POST /api/assets - Register a new fixed asset
router.post('/', async (req, res) => {
  try {
    const {
      name,
      category,
      purchaseDate,
      purchaseCost,
      usefulLifeYears,
      salvageValue,
      depreciationMethod,
      annualDepreciation,
      location,
      supplierOrVendor,
      invoiceReceiptNo,
      paymentMethod,
      notes,
    } = req.body;

    if (!name || !purchaseCost) {
      return res.status(400).json({ error: 'Asset name and purchase cost are required' });
    }

    const costNum = parseFloat(purchaseCost);
    if (isNaN(costNum) || costNum <= 0) {
      return res.status(400).json({ error: 'Purchase cost must be a positive number' });
    }

    const count = await prisma.fixedAsset.count();
    const assetCode = `AST-${String(count + 1001)}`;

    const usefulLife = parseFloat(usefulLifeYears) || 5;
    const salvage = parseFloat(salvageValue) || 0;
    let annualDep = parseFloat(annualDepreciation) || 0;
    if (annualDep <= 0 && usefulLife > 0) {
      annualDep = Math.max(0, (costNum - salvage) / usefulLife);
    }

    const parsedPurchaseDate = purchaseDate ? new Date(purchaseDate) : new Date();

    const newAsset = await prisma.fixedAsset.create({
      data: {
        assetCode,
        name: name.trim(),
        category: category || 'Store Machinery & AC',
        purchaseDate: parsedPurchaseDate,
        purchaseCost: costNum,
        usefulLifeYears: usefulLife,
        salvageValue: salvage,
        depreciationMethod: depreciationMethod || 'StraightLine',
        annualDepreciation: annualDep,
        location: location || 'Main Shop Floor',
        supplierOrVendor: supplierOrVendor || null,
        invoiceReceiptNo: invoiceReceiptNo || null,
        paymentMethod: paymentMethod || 'Cash',
        status: 'Active',
        notes: notes || null,
      },
    });

    res.status(201).json(computeAssetValuation(newAsset));
  } catch (err) {
    console.error('Error creating fixed asset:', err);
    res.status(500).json({ error: 'Failed to create fixed asset record' });
  }
});

// 4. PUT /api/assets/:id - Update an existing fixed asset
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      category,
      purchaseDate,
      purchaseCost,
      usefulLifeYears,
      salvageValue,
      depreciationMethod,
      annualDepreciation,
      location,
      supplierOrVendor,
      invoiceReceiptNo,
      paymentMethod,
      status,
      notes,
    } = req.body;

    const existing = await prisma.fixedAsset.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    const costNum = purchaseCost !== undefined ? parseFloat(purchaseCost) : existing.purchaseCost;
    const usefulLife = usefulLifeYears !== undefined ? parseFloat(usefulLifeYears) : existing.usefulLifeYears;
    const salvage = salvageValue !== undefined ? parseFloat(salvageValue) : existing.salvageValue;
    
    let annualDep = annualDepreciation !== undefined ? parseFloat(annualDepreciation) : existing.annualDepreciation;
    if (annualDep <= 0 && usefulLife > 0) {
      annualDep = Math.max(0, (costNum - salvage) / usefulLife);
    }

    const updated = await prisma.fixedAsset.update({
      where: { id },
      data: {
        name: name !== undefined ? name.trim() : existing.name,
        category: category !== undefined ? category : existing.category,
        purchaseDate: purchaseDate ? new Date(purchaseDate) : existing.purchaseDate,
        purchaseCost: costNum,
        usefulLifeYears: usefulLife,
        salvageValue: salvage,
        depreciationMethod: depreciationMethod || existing.depreciationMethod,
        annualDepreciation: annualDep,
        location: location !== undefined ? location : existing.location,
        supplierOrVendor: supplierOrVendor !== undefined ? supplierOrVendor : existing.supplierOrVendor,
        invoiceReceiptNo: invoiceReceiptNo !== undefined ? invoiceReceiptNo : existing.invoiceReceiptNo,
        paymentMethod: paymentMethod || existing.paymentMethod,
        status: status || existing.status,
        notes: notes !== undefined ? notes : existing.notes,
      },
    });

    res.json(computeAssetValuation(updated));
  } catch (err) {
    console.error('Error updating fixed asset:', err);
    res.status(500).json({ error: 'Failed to update fixed asset' });
  }
});

// 5. DELETE /api/assets/:id - Delete / Dispose fixed asset
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.fixedAsset.delete({ where: { id } });
    res.json({ success: true, message: 'Fixed asset deleted successfully' });
  } catch (err) {
    console.error('Error deleting fixed asset:', err);
    res.status(500).json({ error: 'Failed to delete fixed asset' });
  }
});

module.exports = router;
