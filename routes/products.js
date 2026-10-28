const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');

const formatExpiryDate = (d) => {
  if (!d) return '';
  try {
    const dateObj = new Date(d);
    if (isNaN(dateObj.getTime())) return '';
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const y = String(dateObj.getFullYear()).slice(-2);
    return `${m}/${y}`; // e.g. "12/27"
  } catch (e) {
    return '';
  }
};

// GET /api/products - Read all products with optional search query & category & company filter
router.get('/', async (req, res) => {
  try {
    const { search, category, company } = req.query;

    const where = {};
    if (search) {
      where.OR = [
        { name: { contains: search } },
        { productCode: { contains: search } },
        { genericName: { contains: search } },
        { brandName: { contains: search } },
        { companyName: { contains: search } },
        { barcode: { contains: search } },
      ];
    }

    if (category && category !== 'All') {
      where.category = category;
    }

    if (company && company !== 'All') {
      where.companyName = { contains: company, mode: 'insensitive' };
    }

    const userId = req.headers['x-user-id'] || req.query.userId;
    const userRole = req.headers['x-user-role'];
    if (userId && userRole !== 'SuperAdmin') {
      where.userId = userId;
    }

    const products = await prisma.product.findMany({
      where,
      include: {
        vendor: true,
        batches: {
          orderBy: { expiryDate: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const now = new Date();

    const enriched = products.map((p) => {
      // Calculate consolidated total stock across active batches
      const hasBatches = Array.isArray(p.batches) && p.batches.length > 0;
      const batchStockSum = hasBatches
        ? p.batches.reduce((sum, b) => sum + (b.quantity || 0), 0)
        : p.stockQuantity;

      // Effective total stock: if batches exist, use sum of batch quantities, else fallback to stockQuantity
      const totalStock = hasBatches ? batchStockSum : p.stockQuantity;

      const formattedBatches = (p.batches || []).map((b) => {
        const expDate = b.expiryDate ? new Date(b.expiryDate) : null;
        const isExp = expDate ? expDate < now : false;
        const daysLeft = expDate ? Math.ceil((expDate - now) / (1000 * 60 * 60 * 24)) : null;

        return {
          ...b,
          formattedExpiry: b.expiryDateFormatted || formatExpiryDate(b.expiryDate),
          isExpired: isExp,
          daysToExpiry: daysLeft,
        };
      });

      return {
        ...p,
        totalStock,
        stockQuantity: totalStock, // Ensure consistency across all views
        batches: formattedBatches,
      };
    });

    res.json(enriched);
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// GET /api/products/:id/batches - Retrieve all available batches for a specific product
router.get('/:id/batches', async (req, res) => {
  try {
    const { id } = req.params;

    // Find product by id or productCode
    const product = await prisma.product.findFirst({
      where: {
        OR: [{ id: id }, { productCode: id }],
      },
      include: {
        batches: {
          orderBy: { expiryDate: 'asc' },
        },
      },
    });

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const now = new Date();

    // If product has no ProductBatch records yet, create a default one from product's existing batchNo/stock
    let batches = product.batches;
    if ((!batches || batches.length === 0) && (product.stockQuantity > 0 || product.batchNo)) {
      try {
        const defaultBatch = await prisma.productBatch.create({
          data: {
            productId: product.id,
            batchNo: product.batchNo || 'B-101',
            expiryDate: product.expiryDate || null,
            expiryDateFormatted: formatExpiryDate(product.expiryDate),
            quantity: Math.max(0, product.stockQuantity || 0),
            costPrice: product.costPrice || 0,
            tradePrice: product.tradePrice || 0,
            retailPrice: product.retailPrice || 0,
          },
        });
        batches = [defaultBatch];
      } catch (err) {
        console.warn('Auto batch creation notice:', err.message);
      }
    }

    const formattedBatches = (batches || []).map((b) => {
      const expDate = b.expiryDate ? new Date(b.expiryDate) : null;
      const isExp = expDate ? expDate < now : false;
      const daysLeft = expDate ? Math.ceil((expDate - now) / (1000 * 60 * 60 * 24)) : null;

      return {
        ...b,
        formattedExpiry: b.expiryDateFormatted || formatExpiryDate(b.expiryDate),
        isExpired: isExp,
        daysToExpiry: daysLeft,
      };
    });

    const totalStock = formattedBatches.reduce((sum, b) => sum + (b.quantity || 0), 0);

    res.json({
      product: {
        id: product.id,
        productCode: product.productCode,
        name: product.name,
        genericName: product.genericName,
        totalStock,
        tradePrice: product.tradePrice,
        retailPrice: product.retailPrice,
      },
      batches: formattedBatches,
    });
  } catch (error) {
    console.error('Error fetching product batches:', error);
    res.status(500).json({ error: 'Failed to fetch product batches' });
  }
});

// GET /api/products/meta/companies - Retrieve distinct pharmaceutical manufacturer companies
router.get('/meta/companies', async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      select: {
        id: true,
        companyName: true,
        stockQuantity: true,
        tradePrice: true,
        retailPrice: true,
      },
    });

    const DEFAULT_PHARMA_COMPANIES = [
      { name: 'GSK Pakistan', code: 'GSK', country: 'Pakistan / UK' },
      { name: 'Abbott Laboratories', code: 'ABT', country: 'Pakistan / USA' },
      { name: 'Getz Pharma', code: 'GETZ', country: 'Pakistan' },
      { name: 'Pfizer Pakistan', code: 'PFZ', country: 'Pakistan / USA' },
      { name: 'Sami Pharmaceuticals', code: 'SAMI', country: 'Pakistan' },
      { name: 'Ferozsons Laboratories', code: 'FRZ', country: 'Pakistan' },
      { name: 'Hilton Pharma', code: 'HLT', country: 'Pakistan' },
      { name: 'The Searle Company', code: 'SRL', country: 'Pakistan' },
      { name: 'Sanofi Aventis', code: 'SNF', country: 'Pakistan / France' },
      { name: 'Bosch Pharmaceuticals', code: 'BSH', country: 'Pakistan' },
      { name: 'CCL Pharmaceuticals', code: 'CCL', country: 'Pakistan' },
      { name: 'Martin Dow', code: 'MDW', country: 'Pakistan' },
      { name: 'Highnoon Laboratories', code: 'HNL', country: 'Pakistan' },
      { name: 'Barrett Hodgson', code: 'BH', country: 'Pakistan' },
      { name: 'PharmEvo Private Ltd', code: 'EVO', country: 'Pakistan' },
      { name: 'Platinum Pharmaceuticals', code: 'PLT', country: 'Pakistan' },
      { name: 'Atco Laboratories', code: 'ATC', country: 'Pakistan' },
      { name: 'Wilson\'s Pharmaceuticals', code: 'WLS', country: 'Pakistan' },
      { name: 'Genix Pharma', code: 'GNX', country: 'Pakistan' },
      { name: 'Medisure Laboratories', code: 'MED', country: 'Pakistan' },
      { name: 'Macter International', code: 'MCT', country: 'Pakistan' },
      { name: 'Nabiqasim Pharma', code: 'NBP', country: 'Pakistan' },
      { name: 'Reckitt Benckiser', code: 'RB', country: 'Pakistan / UK' },
      { name: 'Novartis Pharma', code: 'NVR', country: 'Pakistan / Switzerland' },
      { name: 'Bayer Pakistan', code: 'BYR', country: 'Pakistan / Germany' },
      { name: 'Indus Pharma', code: 'IND', country: 'Pakistan' },
      { name: 'Helix Pharma', code: 'HLX', country: 'Pakistan' },
      { name: 'Scotmann Pharmaceuticals', code: 'SCT', country: 'Pakistan' },
    ];

    const companyStats = {};

    // Initialize with defaults
    DEFAULT_PHARMA_COMPANIES.forEach((c) => {
      companyStats[c.name.toLowerCase().trim()] = {
        name: c.name,
        code: c.code,
        country: c.country,
        productCount: 0,
        totalStock: 0,
      };
    });

    // Aggregate from database products
    products.forEach((p) => {
      const cName = (p.companyName || '').trim();
      if (!cName) return;
      const key = cName.toLowerCase().trim();
      if (!companyStats[key]) {
        companyStats[key] = {
          name: cName,
          code: cName.substring(0, 4).toUpperCase(),
          country: 'Pakistan',
          productCount: 0,
          totalStock: 0,
        };
      }
      companyStats[key].productCount += 1;
      companyStats[key].totalStock += (p.stockQuantity || 0);
    });

    const list = Object.values(companyStats).sort((a, b) => {
      if (b.productCount !== a.productCount) return b.productCount - a.productCount;
      return a.name.localeCompare(b.name);
    });

    res.json(list);
  } catch (error) {
    console.error('Error fetching pharma companies meta:', error);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

// GET /api/products/meta/suggestions - Retrieve distinct formulas (genericName), brandNames, and companyNames for instant autocomplete
router.get('/meta/suggestions', async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      select: {
        genericName: true,
        brandName: true,
        companyName: true,
      },
    });

    const formulaCounts = {};
    const brandCounts = {};
    const companyCounts = {};

    products.forEach((p) => {
      const g = (p.genericName || '').trim();
      if (g) {
        formulaCounts[g] = (formulaCounts[g] || 0) + 1;
      }
      const b = (p.brandName || '').trim();
      if (b) {
        brandCounts[b] = (brandCounts[b] || 0) + 1;
      }
      const c = (p.companyName || '').trim();
      if (c) {
        companyCounts[c] = (companyCounts[c] || 0) + 1;
      }
    });

    const formulas = Object.entries(formulaCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    const brands = Object.entries(brandCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    const companies = Object.entries(companyCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    res.json({
      formulas,
      brands,
      companies,
    });
  } catch (error) {
    console.error('Error fetching product suggestions meta:', error);
    res.status(500).json({ error: 'Failed to fetch suggestions' });
  }
});

// GET /api/products/substitutes - Find alternative brand medicines with same Generic Salt / Formula
router.get('/substitutes', async (req, res) => {
  try {
    const { genericName, query } = req.query;

    if (!genericName && !query) {
      return res.status(400).json({ error: 'genericName or query search parameter is required' });
    }

    const searchTerm = (genericName || query).trim();

    // Find all products matching the generic formula or salt
    const substitutes = await prisma.product.findMany({
      where: {
        OR: [
          { genericName: { contains: searchTerm } },
          { name: { contains: searchTerm } },
        ],
        isQuarantined: false,
      },
      include: { vendor: true },
      orderBy: [
        { stockQuantity: 'desc' },
        { retailPrice: 'asc' },
      ],
    });

    res.json(substitutes);
  } catch (error) {
    console.error('Error fetching salt substitutes:', error);
    res.status(500).json({ error: 'Failed to fetch formula substitutes' });
  }
});

// GET /api/products/:id - Read single product detail
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const product = await prisma.product.findUnique({
      where: { id },
      include: { vendor: true },
    });

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json(product);
  } catch (error) {
    console.error('Error fetching product detail:', error);
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

// POST /api/products/bulk-import - Bulk import medicines & products from Excel or CSV
router.post('/bulk-import', async (req, res) => {
  try {
    const { products: rawProducts, updateExisting = true, defaultCategory = 'Tablets', defaultUnit = 'Box' } = req.body;

    const items = Array.isArray(rawProducts) ? rawProducts : (Array.isArray(req.body) ? req.body : []);

    if (items.length === 0) {
      return res.status(400).json({ error: 'No products provided for import' });
    }

    // 1. Resolve or create default vendor
    let defaultVendor = await prisma.vendor.findFirst();
    if (!defaultVendor) {
      defaultVendor = await prisma.vendor.create({
        data: { name: 'General Pharma Distributor', area: 'Main Market', contactNo: '+92 300 0000000' },
      });
    }

    // 2. Fetch existing products for code/barcode collision check
    const existingProducts = await prisma.product.findMany({
      select: { id: true, productCode: true, barcode: true, name: true, stockQuantity: true },
    });

    const codeMap = new Map();
    const barcodeMap = new Map();
    let maxNumericCode = 0;

    existingProducts.forEach((p) => {
      if (p.productCode) {
        codeMap.set(String(p.productCode).trim().toLowerCase(), p);
        const num = parseInt(p.productCode, 10);
        if (!isNaN(num) && num > maxNumericCode) maxNumericCode = num;
      }
      if (p.barcode) {
        barcodeMap.set(String(p.barcode).trim().toLowerCase(), p);
      }
    });

    const parseDateHelper = (val) => {
      if (!val) return null;
      if (val instanceof Date && !isNaN(val.getTime())) return val;
      // Excel serial number
      if (typeof val === 'number') {
        const d = new Date(Math.round((val - 25569) * 86400 * 1000));
        return isNaN(d.getTime()) ? null : d;
      }
      const s = String(val).trim();
      if (!s) return null;

      // Handle MM/YY or MM/YYYY (e.g. 12/28 or 12/2028)
      const slashParts = s.split('/');
      if (slashParts.length === 2) {
        const month = parseInt(slashParts[0], 10);
        let year = parseInt(slashParts[1], 10);
        if (year < 100) year += 2000;
        if (month >= 1 && month <= 12 && year >= 2000 && year <= 2100) {
          return new Date(year, month, 0); // Last day of month
        }
      }

      const parsed = new Date(s);
      return isNaN(parsed.getTime()) ? null : parsed;
    };

    let createdCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    const processedItems = [];

    // Process all items in transaction or sequential batch
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const name = (item.name || item.itemName || item.title || item.productName || '').trim();

      if (!name) {
        skippedCount++;
        continue;
      }

      let code = (item.productCode || item.code || item.itemCode || '').trim();
      const rawBarcode = (item.barcode || item.upc || item.sku || '').trim() || null;
      const genericName = (item.genericName || item.formula || item.generic || item.salt || '').trim() || null;
      const brandName = (item.brandName || item.brand || '').trim() || null;
      const companyName = (item.companyName || item.company || item.manufacturer || '').trim() || 'GSK Pakistan';
      const category = (item.category || item.group || defaultCategory || 'Tablets').trim();
      const subcategory = (item.subcategory || item.subCategory || '').trim() || null;
      const unit = (item.unit || item.uom || defaultUnit || 'Box').trim();
      const packSize = (item.packSize || item.pack || '10x10').trim();

      const purchasePrice = parseFloat(item.purchasePrice || item.costPrice || item.tpRate || 0) || 0;
      const tradePrice = parseFloat(item.tradePrice || item.tp || item.purchasePrice || 0) || 0;
      const retailPrice = parseFloat(item.retailPrice || item.mrp || item.salePrice || item.price || 0) || tradePrice;
      const mrp = parseFloat(item.mrp || retailPrice || 0) || retailPrice;
      const wholesalePrice = parseFloat(item.wholesalePrice || item.wsPrice || tradePrice || 0) || 0;
      const costPrice = parseFloat(item.costPrice || purchasePrice || tradePrice || 0) || tradePrice;

      const stockQuantity = parseInt(item.stockQuantity || item.stock || item.quantity || item.qty || 0, 10) || 0;
      const minStock = parseInt(item.minStock || item.reorderLevel || 10, 10) || 10;
      const maxStock = parseInt(item.maxStock || 1000, 10) || 1000;

      const batchNo = (item.batchNo || item.batch || '').trim() || (stockQuantity > 0 ? `B-${new Date().getFullYear()}` : null);
      const expiryDate = parseDateHelper(item.expiryDate || item.expiry || item.expDate);
      const mfgDate = parseDateHelper(item.mfgDate || item.mfg);
      const drugRegNo = (item.drugRegNo || item.regNo || '').trim() || null;
      const storageInstructions = (item.storageInstructions || item.storage || 'Store below 25°C in a dry place').trim();

      // Check if product with this code or barcode exists
      let existing = null;
      if (code && codeMap.has(code.toLowerCase())) {
        existing = codeMap.get(code.toLowerCase());
      } else if (rawBarcode && barcodeMap.has(rawBarcode.toLowerCase())) {
        existing = barcodeMap.get(rawBarcode.toLowerCase());
      }

      if (existing && updateExisting) {
        // Update existing product
        const updated = await prisma.product.update({
          where: { id: existing.id },
          data: {
            name,
            genericName: genericName || existing.genericName,
            brandName: brandName || existing.brandName,
            companyName: companyName || existing.companyName,
            category: category || existing.category,
            subcategory: subcategory || existing.subcategory,
            barcode: rawBarcode || existing.barcode,
            unit: unit || existing.unit,
            packSize: packSize || existing.packSize,
            purchasePrice: purchasePrice || existing.purchasePrice,
            tradePrice: tradePrice || existing.tradePrice,
            mrp: mrp || existing.mrp,
            retailPrice: retailPrice || existing.retailPrice,
            wholesalePrice: wholesalePrice || existing.wholesalePrice,
            costPrice: costPrice || existing.costPrice,
            stockQuantity: stockQuantity > 0 ? (existing.stockQuantity + stockQuantity) : existing.stockQuantity,
            minStock: minStock || existing.minStock,
            maxStock: maxStock || existing.maxStock,
            batchNo: batchNo || existing.batchNo,
            expiryDate: expiryDate || existing.expiryDate,
            mfgDate: mfgDate || existing.mfgDate,
            drugRegNo: drugRegNo || existing.drugRegNo,
            storageInstructions: storageInstructions || existing.storageInstructions,
          },
        });

        // Add batch if stock / batch specified
        if (stockQuantity > 0 || batchNo) {
          try {
            await prisma.productBatch.create({
              data: {
                productId: updated.id,
                batchNo: batchNo || `B-${Date.now().toString().slice(-4)}`,
                expiryDate: expiryDate || null,
                expiryDateFormatted: formatExpiryDate(expiryDate),
                quantity: Math.max(0, stockQuantity),
                costPrice: costPrice || 0,
                tradePrice: tradePrice || 0,
                retailPrice: retailPrice || 0,
              },
            });
          } catch (batchErr) {}
        }

        updatedCount++;
        processedItems.push(updated);
      } else {
        // Create new product
        if (!code || codeMap.has(code.toLowerCase())) {
          maxNumericCode++;
          code = String(maxNumericCode);
        }

        const created = await prisma.product.create({
          data: {
            productCode: code,
            name,
            genericName,
            brandName,
            companyName,
            category,
            subcategory,
            barcode: rawBarcode,
            unit,
            packSize,
            vendorId: defaultVendor.id,
            purchasePrice,
            tradePrice,
            mrp,
            retailPrice,
            wholesalePrice,
            costPrice,
            stockQuantity,
            availableStock: stockQuantity,
            minStock,
            maxStock,
            batchNo,
            mfgDate,
            expiryDate,
            drugRegNo,
            storageInstructions,
          },
        });

        // Register in cache
        codeMap.set(code.toLowerCase(), created);
        if (rawBarcode) barcodeMap.set(rawBarcode.toLowerCase(), created);

        // Add ProductBatch record if stock or batch provided
        if (stockQuantity > 0 || batchNo) {
          try {
            await prisma.productBatch.create({
              data: {
                productId: created.id,
                batchNo: batchNo || `B-${new Date().getFullYear()}`,
                expiryDate: expiryDate || null,
                expiryDateFormatted: formatExpiryDate(expiryDate),
                quantity: Math.max(0, stockQuantity),
                costPrice: costPrice || 0,
                tradePrice: tradePrice || 0,
                retailPrice: retailPrice || 0,
              },
            });
          } catch (batchErr) {}
        }

        createdCount++;
        processedItems.push(created);
      }
    }

    res.status(200).json({
      success: true,
      message: `Successfully processed ${createdCount + updatedCount} products (${createdCount} created, ${updatedCount} updated, ${skippedCount} skipped).`,
      totalProcessed: createdCount + updatedCount,
      createdCount,
      updatedCount,
      skippedCount,
      items: processedItems,
    });
  } catch (error) {
    console.error('Error during bulk product import:', error);
    res.status(500).json({ error: error.message || 'Failed to complete bulk product import' });
  }
});

// POST /api/products - Create new pharmaceutical medicine item
router.post('/', async (req, res) => {
  try {
    const {
      productCode,
      name,
      genericName,
      brandName,
      companyName,
      category,
      subcategory,
      barcode,
      sku,
      unit,
      packSize,
      vendorId,
      purchasePrice,
      tradePrice,
      mrp,
      retailPrice,
      wholesalePrice,
      costPrice,
      stockQuantity,
      minStock,
      maxStock,
      batchNo,
      mfgDate,
      expiryDate,
      drugRegNo,
      storageInstructions,
    } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Medicine Product Name is required' });
    }

    const currentTenantUserId = req.body.userId || req.headers['x-user-id'] || null;

    // Resolve or find default Vendor ID safely
    let finalVendorId = null;
    if (vendorId) {
      const existingVend = await prisma.vendor.findUnique({ where: { id: vendorId } }).catch(() => null);
      if (existingVend) finalVendorId = existingVend.id;
    }
    if (!finalVendorId) {
      let defaultVendor = await prisma.vendor.findFirst({
        where: currentTenantUserId ? { OR: [{ userId: currentTenantUserId }, { vendorNo: 1 }] } : { vendorNo: 1 },
      });
      if (!defaultVendor) {
        const allVendors = await prisma.vendor.findMany({ select: { vendorNo: true } });
        const maxVNo = allVendors.reduce((max, v) => Math.max(max, v.vendorNo || 0), 0);
        defaultVendor = await prisma.vendor.create({
          data: {
            userId: currentTenantUserId,
            vendorNo: maxVNo + 1,
            name: 'General Pharma Distributor',
            area: 'Main Wholesale Market',
            contactNo: '+92 300 0000000',
          },
        });
      }
      finalVendorId = defaultVendor.id;
    }

    // Auto-generate clean sequential Product Code if omitted
    let finalCode = productCode ? String(productCode).trim() : '';
    if (!finalCode) {
      const userProducts = await prisma.product.findMany({
        where: currentTenantUserId ? { userId: currentTenantUserId } : {},
        select: { productCode: true },
      });
      const nums = userProducts
        .map((p) => parseInt(p.productCode, 10))
        .filter((n) => !isNaN(n));
      const maxNo = nums.length > 0 ? Math.max(...nums) : 0;
      finalCode = String(maxNo + 1);
    }

    const safeParseDate = (d) => {
      if (!d) return null;
      const dt = new Date(d);
      return isNaN(dt.getTime()) ? null : dt;
    };

    const newProduct = await prisma.product.create({
      data: {
        userId: currentTenantUserId,
        productCode: String(finalCode),
        name: name.trim(),
        genericName: genericName ? String(genericName).trim() : null,
        brandName: brandName ? String(brandName).trim() : null,
        companyName: companyName ? String(companyName).trim() : 'GSK Pakistan',
        category: category || 'Tablets',
        subcategory,
        barcode: barcode ? String(barcode).trim() : null,
        sku: sku ? String(sku).trim() : null,
        unit: unit || 'Box',
        packSize: packSize || '10x10',
        vendorId: finalVendorId,
        purchasePrice: parseFloat(purchasePrice || 0) || 0,
        tradePrice: parseFloat(tradePrice || 0) || 0,
        mrp: parseFloat(mrp || 0) || 0,
        retailPrice: parseFloat(retailPrice || 0) || 0,
        wholesalePrice: parseFloat(wholesalePrice || 0) || 0,
        costPrice: parseFloat(costPrice || tradePrice || 0) || 0,
        stockQuantity: parseInt(stockQuantity || 0, 10) || 0,
        minStock: parseInt(minStock || 10, 10) || 10,
        maxStock: parseInt(maxStock || 1000, 10) || 1000,
        batchNo: batchNo || 'B-101',
        mfgDate: safeParseDate(mfgDate),
        expiryDate: safeParseDate(expiryDate),
        drugRegNo,
        storageInstructions: storageInstructions || 'Store below 25°C',
      },
      include: { vendor: true },
    });

    // Automatically create initial ProductBatch record if batch or stock is provided
    if (newProduct.stockQuantity > 0 || batchNo) {
      try {
        await prisma.productBatch.create({
          data: {
            productId: newProduct.id,
            batchNo: batchNo || 'B-101',
            expiryDate: newProduct.expiryDate || null,
            expiryDateFormatted: formatExpiryDate(newProduct.expiryDate),
            quantity: Math.max(0, newProduct.stockQuantity || 0),
            costPrice: newProduct.costPrice || 0,
            tradePrice: newProduct.tradePrice || 0,
            retailPrice: newProduct.retailPrice || 0,
          },
        });
      } catch (batchErr) {
        console.warn('Initial product batch creation notice:', batchErr.message);
      }
    }

    res.status(201).json(newProduct);
  } catch (error) {
    console.error('Error creating product:', error);
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'Product Code already exists' });
    }
    res.status(500).json({ error: error.message || 'Failed to create product' });
  }
});

// PUT /api/products/:id - Edit existing medicine item
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      genericName,
      brandName,
      companyName,
      category,
      subcategory,
      barcode,
      sku,
      unit,
      packSize,
      vendorId,
      purchasePrice,
      tradePrice,
      mrp,
      retailPrice,
      wholesalePrice,
      costPrice,
      stockQuantity,
      minStock,
      maxStock,
      batchNo,
      mfgDate,
      expiryDate,
      drugRegNo,
      storageInstructions,
    } = req.body;

    const updated = await prisma.product.update({
      where: { id },
      data: {
        name,
        genericName,
        brandName,
        companyName,
        category,
        subcategory,
        barcode,
        sku,
        unit,
        packSize,
        vendorId: vendorId || undefined,
        purchasePrice: purchasePrice !== undefined ? parseFloat(purchasePrice) : undefined,
        tradePrice: tradePrice !== undefined ? parseFloat(tradePrice) : undefined,
        mrp: mrp !== undefined ? parseFloat(mrp) : undefined,
        retailPrice: retailPrice !== undefined ? parseFloat(retailPrice) : undefined,
        wholesalePrice: wholesalePrice !== undefined ? parseFloat(wholesalePrice) : undefined,
        costPrice: costPrice !== undefined ? parseFloat(costPrice) : undefined,
        stockQuantity: stockQuantity !== undefined ? parseInt(stockQuantity, 10) : undefined,
        minStock: minStock !== undefined ? parseInt(minStock, 10) : undefined,
        maxStock: maxStock !== undefined ? parseInt(maxStock, 10) : undefined,
        batchNo,
        mfgDate: mfgDate ? new Date(mfgDate) : null,
        expiryDate: expiryDate ? new Date(expiryDate) : null,
        drugRegNo,
        storageInstructions,
      },
      include: { vendor: true },
    });

    res.json(updated);
  } catch (error) {
    console.error('Error updating product:', error);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// DELETE /api/products/:id - Delete product item safely
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Find target product by ID or productCode
    let targetProduct = await prisma.product.findFirst({
      where: {
        OR: [
          { id: id },
          { productCode: id },
        ],
      },
    });

    if (!targetProduct) {
      return res.status(404).json({ error: 'Product not found in database' });
    }

    const productId = targetProduct.id;

    // Cascade delete linked invoice items, purchase items, and stock adjustments first
    await prisma.$transaction([
      prisma.invoiceItem.deleteMany({ where: { productId } }),
      prisma.purchaseItem.deleteMany({ where: { productId } }),
      prisma.stockAdjustment.deleteMany({ where: { productId } }),
      prisma.product.delete({ where: { id: productId } }),
    ]);

    res.json({ message: 'Product deleted successfully', id: productId });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({ error: error.message || 'Failed to delete product' });
  }
});

module.exports = router;
