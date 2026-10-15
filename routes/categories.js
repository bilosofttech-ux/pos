const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');

const DEFAULT_CATEGORIES = [
  'Tablets',
  'Syrups',
  'Injections',
  'Capsules',
  'Ointments',
  'Drops',
  'Eye Drops',
  'Suspensions',
  'Serums',
  'Equipment',
];

// GET /api/categories - Get all medicine product categories
router.get('/', async (req, res, next) => {
  try {
    const products = await prisma.product.findMany({
      select: { category: true },
      distinct: ['category'],
    });

    const dbCategories = products
      .map((p) => p.category)
      .filter((c) => c && c.trim() !== '');

    const combinedSet = new Set([...DEFAULT_CATEGORIES, ...dbCategories]);
    const categoriesList = Array.from(combinedSet).map((catName, index) => ({
      id: `cat-${index + 1}`,
      name: catName,
    }));

    res.json(categoriesList);
  } catch (error) {
    console.warn('Error fetching categories from DB, returning defaults:', error.message);
    res.json(DEFAULT_CATEGORIES.map((catName, index) => ({ id: `cat-${index + 1}`, name: catName })));
  }
});

// POST /api/categories
router.post('/', async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Category name is required' });
    }
    res.status(201).json({ id: `cat-${Date.now()}`, name });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

