const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');

// GET /api/company - Retrieve Company Profile & Branches for current authenticated user
router.get('/', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'] || req.query.userId || null;
    let company = null;

    if (userId) {
      company = await prisma.company.findFirst({
        where: { userId },
        include: { branches: true },
      });
    } else {
      company = await prisma.company.findFirst({
        where: { userId: null },
        include: { branches: true },
      });
    }

    // Seed dedicated tenant company profile if missing
    if (!company) {
      let storeName = 'My Store & Pharmacy';
      let storeEmail = 'info@store.com';

      if (userId) {
        const u = await prisma.user.findUnique({ where: { id: userId } }).catch(() => null);
        if (u) {
          storeName = u.businessName || (u.fullName ? `${u.fullName}'s Store` : 'My Store & Pharmacy');
          storeEmail = u.email || storeEmail;
        }
      }

      company = await prisma.company.create({
        data: {
          userId: userId || null,
          name: storeName,
          tagline: 'Retail & Wholesale Solutions',
          address: 'Store Counter / Main Branch',
          city: 'Karachi',
          country: 'Pakistan',
          phone: '+92 300 0000000',
          email: storeEmail,
          currency: 'PKR',
          currencySymbol: 'Rs.',
          defaultTaxRate: 0.0,
          fiscalYearStart: new Date('2026-07-01'),
          fiscalYearEnd: new Date('2027-06-30'),
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

// POST /api/company - Update Company Profile Settings for current user workspace
router.post('/', async (req, res) => {
  try {
    const userId = req.body.userId || req.headers['x-user-id'] || null;
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
      name: name || 'My Pharmacy & Store',
      tagline,
      address: address || 'Main Shop / Counter',
      city: city || 'Karachi',
      country: country || 'Pakistan',
      phone: phone || '+92 300 0000000',
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

    let targetCompany = null;
    if (id) {
      targetCompany = await prisma.company.findUnique({ where: { id } }).catch(() => null);
    }
    if (!targetCompany && userId) {
      targetCompany = await prisma.company.findFirst({ where: { userId } }).catch(() => null);
    }

    let updated;
    if (targetCompany) {
      updated = await prisma.company.update({
        where: { id: targetCompany.id },
        data: {
          ...data,
          userId: targetCompany.userId || userId,
        },
        include: { branches: true },
      });
    } else {
      updated = await prisma.company.create({
        data: {
          ...data,
          userId,
        },
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
      where: { id },
    });

    if (!branch) {
      return res.status(404).json({ error: 'Branch not found' });
    }

    if (branch.isMain) {
      return res.status(400).json({ error: 'Main branch cannot be deleted' });
    }

    await prisma.branch.delete({ where: { id } });
    res.json({ success: true, message: 'Branch deleted successfully' });
  } catch (err) {
    console.error('Error deleting branch:', err);
    res.status(500).json({ error: 'Failed to delete branch' });
  }
});

module.exports = router;
