const express = require('express');
const prisma = require('../lib/prisma');

const router = express.Router();

const DEFAULT_VENDORS = [
  { vendorNo: 1, name: 'General Vendor', area: 'Main Wholesale Market', contactNo: 'N/A' },
];

// Helper to ensure Default Vendors (#1 to #8) exist in PostgreSQL
async function ensureDefaultVendors() {
  try {
    for (const v of DEFAULT_VENDORS) {
      const existing = await prisma.vendor.findFirst({ where: { vendorNo: v.vendorNo } });
      if (!existing) {
        await prisma.vendor.create({
          data: {
            vendorNo: v.vendorNo,
            name: v.name,
            area: v.area,
            contactNo: v.contactNo,
          },
        });
      }
    }
  } catch (err) {
    console.error('Error ensuring default vendors:', err);
  }
}

// GET all vendors
router.get('/', async (req, res, next) => {
  try {
    await ensureDefaultVendors();
    const vendors = await prisma.vendor.findMany({
      orderBy: { vendorNo: 'asc' },
    });

    // Map contactNo to contact for frontend compatibility
    const formatted = vendors.map((v) => ({
      ...v,
      contact: v.contactNo || 'N/A',
    }));

    res.json(formatted);
  } catch (error) {
    next(error);
  }
});

// POST new vendor (with optional selected vendorNo)
router.post('/', async (req, res, next) => {
  try {
    await ensureDefaultVendors();

    const name = req.body.name ? String(req.body.name).trim() : '';
    const area = req.body.area || 'Main Wholesale Market';
    const contactNo = req.body.contactNo || req.body.contact || 'N/A';

    if (!name) {
      return res.status(400).json({ error: 'Vendor name is required' });
    }

    let parsedVendorNo = parseInt(req.body.vendorNo, 10);
    if (isNaN(parsedVendorNo) || parsedVendorNo <= 0) {
      const maxVendor = await prisma.vendor.findFirst({ orderBy: { vendorNo: 'desc' } });
      parsedVendorNo = maxVendor ? maxVendor.vendorNo + 1 : 2;
    } else {
      const existing = await prisma.vendor.findFirst({ where: { vendorNo: parsedVendorNo } });
      if (existing) {
        const maxVendor = await prisma.vendor.findFirst({ orderBy: { vendorNo: 'desc' } });
        parsedVendorNo = maxVendor ? maxVendor.vendorNo + 1 : 2;
      }
    }

    const newVendor = await prisma.vendor.create({
      data: {
        vendorNo: Number(parsedVendorNo),
        name: String(name),
        area: String(area),
        contactNo: String(contactNo),
      },
    });

    res.status(201).json({
      ...newVendor,
      contact: newVendor.contactNo,
    });
  } catch (error) {
    console.error('Error in POST /api/vendors:', error);
    next(error);
  }
});

// DELETE vendor by id or vendorNo
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    // Check if vendor exists
    const vendor = await prisma.vendor.findFirst({
      where: {
        OR: [
          { id: id },
          { vendorNo: isNaN(parseInt(id, 10)) ? undefined : parseInt(id, 10) },
        ],
      },
    });

    if (!vendor) {
      return res.status(404).json({ error: 'Vendor not found' });
    }

    if (vendor.vendorNo === 1) {
      return res.status(400).json({ error: 'Default General Vendor #1 cannot be deleted.' });
    }

    await prisma.vendor.delete({
      where: { id: vendor.id },
    });

    res.json({ message: `Vendor #${vendor.vendorNo} deleted successfully.` });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
