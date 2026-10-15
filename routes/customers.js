const express = require('express');
const prisma = require('../lib/prisma');

const router = express.Router();

// Helper to ensure Default Customer Account #1 (Counter Sale) exists in DB
async function ensureCounterSaleCustomer() {
  try {
    const count = await prisma.customer.count();
    if (count === 0) {
      await prisma.customer.create({
        data: {
          accountNo: 1,
          name: 'Counter Sale',
          address: 'Local Wholesale Market',
          contactNo: 'N/A',
        },
      });
    }
  } catch (err) {
    console.error('Error ensuring counter sale customer:', err);
  }
}

// GET all customers ordered by accountNo ascending
router.get('/', async (req, res, next) => {
  try {
    await ensureCounterSaleCustomer();
    const customers = await prisma.customer.findMany({
      orderBy: { accountNo: 'asc' },
    });
    res.json(customers);
  } catch (error) {
    next(error);
  }
});

// GET customer by id or accountNo
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const customer = await prisma.customer.findFirst({
      where: {
        OR: [
          { id: id },
          { accountNo: isNaN(parseInt(id, 10)) ? undefined : parseInt(id, 10) },
        ],
      },
    });
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    res.json(customer);
  } catch (error) {
    next(error);
  }
});

// POST new customer (supports custom accountNo & customerType)
router.post('/', async (req, res, next) => {
  try {
    await ensureCounterSaleCustomer();

    const name = req.body.name ? String(req.body.name).trim() : '';
    const address = req.body.address || req.body.area || 'Local Wholesale Market';
    const contactNo = req.body.contactNo || req.body.contact || 'N/A';
    const customerType = req.body.customerType || 'Retailer';

    if (!name) {
      return res.status(400).json({ error: 'Customer name is required' });
    }

    let parsedAccountNo = parseInt(req.body.accountNo, 10);
    if (isNaN(parsedAccountNo) || parsedAccountNo <= 0) {
      const maxCust = await prisma.customer.findFirst({ orderBy: { accountNo: 'desc' } });
      parsedAccountNo = maxCust ? maxCust.accountNo + 1 : 2;
    } else {
      const existing = await prisma.customer.findUnique({ where: { accountNo: parsedAccountNo } });
      if (existing) {
        const maxCust = await prisma.customer.findFirst({ orderBy: { accountNo: 'desc' } });
        parsedAccountNo = maxCust ? maxCust.accountNo + 1 : 2;
      }
    }

    const newCustomer = await prisma.customer.create({
      data: {
        accountNo: Number(parsedAccountNo),
        name: String(name),
        address: String(address),
        contactNo: String(contactNo),
        customerType: String(customerType),
      },
    });

    res.status(201).json(newCustomer);
  } catch (error) {
    console.error('Error in POST /api/customers:', error);
    next(error);
  }
});

// PUT update customer
router.put('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, address, contactNo, customerType } = req.body;

    const existing = await prisma.customer.findFirst({
      where: {
        OR: [
          { id: id },
          { accountNo: isNaN(parseInt(id, 10)) ? undefined : parseInt(id, 10) },
        ],
      },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const updated = await prisma.customer.update({
      where: { id: existing.id },
      data: {
        name: name || existing.name,
        address: address !== undefined ? address : existing.address,
        contactNo: contactNo !== undefined ? contactNo : existing.contactNo,
        customerType: customerType || existing.customerType,
      },
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

// DELETE customer by id or accountNo
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    const customer = await prisma.customer.findFirst({
      where: {
        OR: [
          { id: id },
          { accountNo: isNaN(parseInt(id, 10)) ? undefined : parseInt(id, 10) },
        ],
      },
    });

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    if (customer.accountNo === 1) {
      return res.status(400).json({ error: 'Default Counter Sale Account #1 cannot be deleted.' });
    }

    await prisma.customer.delete({
      where: { id: customer.id },
    });

    res.json({ message: `Customer Account #${customer.accountNo} deleted successfully.` });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
