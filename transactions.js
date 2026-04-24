import express from 'express';
import prisma from './prisma.js';
import { authenticate, requireLevel } from './middleware.js';

const router = express.Router();

// GET transactions with filters
router.get('/', authenticate, requireLevel(7), async (req, res) => {
  try {
    const { hotelId, type, category, startDate, endDate, page = 1, limit = 20 } = req.query;
    const where = {};

    if (req.user.role !== 'SUPER_ADMIN') where.hotelId = req.user.hotelId;
    else if (hotelId) where.hotelId = hotelId;

    if (type) where.type = type;
    if (category) where.category = category;
    if (startDate && endDate) {
      where.createdAt = { gte: new Date(startDate), lte: new Date(endDate) };
    }

    const [transactions, total, summary] = await Promise.all([
      prisma.transaction.findMany({
        where,
        include: {
          roomLog: { select: { guestName: true, room: { select: { number: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit),
      }),
      prisma.transaction.count({ where }),
      prisma.transaction.groupBy({
        by: ['type'],
        where,
        _sum: { amount: true },
      }),
    ]);

    res.json({
      transactions,
      total,
      pages: Math.ceil(total / parseInt(limit)),
      summary,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// CREATE manual transaction (Level 7+)
router.post('/', authenticate, requireLevel(7), async (req, res) => {
  try {
    const { hotelId, type, category, amount, description, paymentMethod } = req.body;
    if (!type || !amount || !category) {
      return res.status(400).json({ error: 'Type, amount, and category required' });
    }

    const tx = await prisma.transaction.create({
      data: {
        hotelId: hotelId || req.user.hotelId,
        type,
        category,
        amount: parseFloat(amount),
        description,
        paymentMethod: paymentMethod || 'CASH',
      },
    });

    res.status(201).json(tx);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create transaction' });
  }
});

export default router;
