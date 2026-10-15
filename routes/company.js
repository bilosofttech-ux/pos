const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');

// GET /api/company - Retrieve Company Profile & Branches
router.get('/', async (req, res) => {
  try {
    let company = await prisma.company.findFirst({
      include: { branches: true },
    });

    // Seed default company profile if empty
    if (!company) {
      company = await prisma.company.create({
        data: {
          name: 'Pharmacare Wholesale & ERP',
          tagline: 'Leading Pharmaceutical Distributors',
          address: 'Shaheen Plaza, Main Wholesale Medicine Market',
          city: 'Karachi',
          country: 'Pakistan',
          phone: '+92 21 34567890',
          email: 'info@pharmacareerp.com',
          ntnTaxNo: 'NTN-8923411-9',
          drugLicenseNo: 'DL-KHI-2026-99',
          logoUrl: 'https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=200&auto=format&fit=crop&q=80',
          currency: 'PKR',
          currencySymbol: 'Rs.',
          defaultTaxRate: 0.0,
          fiscalYearStart: new Date('2026-07-01'),
          fiscalYearEnd: new Date('2027-06-30'),
          branches: {
            create: [
              {
                branchCode: 'MAIN-01',
                name: 'Head Office & Main Warehouse',
                city: 'Karachi',
                address: 'Main Wholesale Medicine Market',
                phone: '+92 300 1234567',
                isMain: true,
              },
            ],
          },
        },
        include: { branches: true },
      });
    }

    res.json(company);
  } catch (err) {
    console.error('Error fetching company profile:', err);
    res.status(500).json({ error: 'Failed to fetch company profile' });
  }
});

// POST /api/company - Update Company Profile Settings
router.post('/', async (req, res) => {
  try {
    const {
      id,
      name,
      tagline,
      address,
      city,
      country,
      phone,
      email,
      ntnTaxNo,
      drugLicenseNo,
      logoUrl,
      currency,
      currencySymbol,
      defaultTaxRate,
      fiscalYearStart,
      fiscalYearEnd,
    } = req.body;

    const data = {
      name: name || 'Pharmacare Wholesale & ERP',
      tagline,
      address,
      city: city || 'Karachi',
      country: country || 'Pakistan',
      phone,
      email,
      ntnTaxNo,
      drugLicenseNo,
      logoUrl,
      currency: currency || 'PKR',
      currencySymbol: currencySymbol || 'Rs.',
      defaultTaxRate: parseFloat(defaultTaxRate || 0),
      fiscalYearStart: fiscalYearStart ? new Date(fiscalYearStart) : new Date('2026-07-01'),
      fiscalYearEnd: fiscalYearEnd ? new Date(fiscalYearEnd) : new Date('2027-06-30'),
    };

    let updated;
    if (id) {
      updated = await prisma.company.update({
        where: { id },
        data,
        include: { branches: true },
      });
    } else {
      updated = await prisma.company.create({
        data,
        include: { branches: true },
      });
    }

    res.json(updated);
  } catch (err) {
    console.error('Error updating company profile:', err);
    res.status(500).json({ error: 'Failed to update company profile' });
  }
});

// POST /api/company/branches - Add a new store branch
router.post('/branches', async (req, res) => {
  try {
    const { companyId, branchCode, name, city, address, phone, isMain } = req.body;

    if (!companyId || !name || !branchCode) {
      return res.status(400).json({ error: 'companyId, branchCode, and name are required' });
    }

    const branch = await prisma.branch.create({
      data: {
        companyId,
        branchCode,
        name,
        city: city || 'Karachi',
        address: address || 'Main Market',
        phone: phone || 'N/A',
        isMain: Boolean(isMain),
      },
    });

    res.json(branch);
  } catch (err) {
    console.error('Error creating branch:', err);
    res.status(500).json({ error: 'Failed to create store branch' });
  }
});

// DELETE /api/company/branches/:id - Delete a store branch
router.delete('/branches/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const branch = await prisma.branch.findFirst({
      where: {
        OR: [
          { id: id },
          { branchCode: id },
        ],
      },
    });

    if (!branch) {
      return res.status(404).json({ error: 'Branch not found' });
    }

    if (branch.isMain) {
      return res.status(400).json({ error: 'Cannot delete the Main Head Office branch.' });
    }

    // Unlink any users assigned to this branch
    await prisma.user.updateMany({
      where: { branchId: branch.id },
      data: { branchId: null },
    });

    await prisma.branch.delete({
      where: { id: branch.id },
    });

    res.json({ message: 'Branch deleted successfully', id: branch.id, branchCode: branch.branchCode });
  } catch (err) {
    console.error('Error deleting branch:', err);
    res.status(500).json({ error: 'Failed to delete store branch' });
  }
});

module.exports = router;
