import express from 'express';
import { z } from 'zod';

const expenseSchema = z.object({
  hotelId:  z.string().min(1, 'Hotel required'),
  title:    z.string().min(2).max(100),
  amount:   z.number().positive('Amount must be positive'),
  category: z.string().min(1).max(50),
  notes:    z.string().max(500).optional(),
});

function zodValidate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten().fieldErrors });
    }
    next();
  };
}
import prisma from './prisma.js';
import { authenticate, requireLevel } from './middleware.js';
import { logAction, getIP, AUDIT_ACTIONS } from './audit.js';

const router = express.Router();

// GET expenses
router.get('/', authenticate, async (req, res) => {
  try {
    const { hotelId, status, startDate, endDate, page = 1, limit = 20 } = req.query;
    const where = {};

    if (req.user.role !== 'SUPER_ADMIN') where.hotelId = req.user.hotelId;
    else if (hotelId) where.hotelId = hotelId;

    if (status) where.status = status;
    if (startDate && endDate) {
      where.createdAt = { gte: new Date(startDate), lte: new Date(endDate) };
    }

    const [expenses, total] = await Promise.all([
      prisma.expense.findMany({
        where,
        include: {
          submittedBy: { select: { name: true } },
          approvedBy: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit),
      }),
      prisma.expense.count({ where }),
    ]);

    res.json({ expenses, total, pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch expenses' });
  }
});

// CREATE expense
router.post('/', authenticate, requireLevel(1), async (req, res) => {
  try {
    const { hotelId, title, amount, category, notes } = req.body;
    if (!title || !amount || !category) {
      return res.status(400).json({ error: 'Title, amount, and category required' });
    }

    const expense = await prisma.expense.create({
      data: {
        hotelId: hotelId || req.user.hotelId,
        title,
        amount: parseFloat(amount),
        category,
        notes,
        submittedById: req.user.id,
        status: 'PENDING',
      },
      include: { submittedBy: { select: { name: true } } },
    });

    res.status(201).json(expense);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create expense' });
  }
});

// APPROVE / REJECT expense (Level 7+)
router.put('/:id/approve', authenticate, requireLevel(7), async (req, res) => {
  try {
    const { action } = req.body; // 'approve' or 'reject'
    const expense = await prisma.expense.findUnique({ where: { id: req.params.id } });
    if (!expense) return res.status(404).json({ error: 'Expense not found' });

    const newStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';

    const updated = await prisma.$transaction(async (tx) => {
      const exp = await tx.expense.update({
        where: { id: req.params.id },
        data: {
          status: newStatus,
          approvedById: req.user.id,
        },
      });

      // Record as transaction if approved
      if (newStatus === 'APPROVED') {
        await tx.transaction.create({
          data: {
            hotelId: expense.hotelId,
            type: 'EXPENSE',
            category: expense.category,
            amount: expense.amount,
            description: expense.title,
            reference: expense.id,
          },
        });
      }

      return exp;
    });

    res.json(updated);

    // Audit log — expense approval/rejection
    logAction({
      userId: req.user.id, userName: req.user.name, userRole: req.user.role,
      hotelId: expense.hotelId,
      action: newStatus === 'APPROVED' ? AUDIT_ACTIONS.EXPENSE_APPROVED : AUDIT_ACTIONS.EXPENSE_REJECTED,
      entityType: 'Expense', entityId: expense.id,
      description: `${req.user.name} ${newStatus === 'APPROVED' ? 'approved' : 'rejected'} expense "${expense.title}" (₦${Number(expense.amount).toLocaleString()})`,
      oldValue: { status: expense.status },
      newValue: { status: newStatus },
      ipAddress: getIP(req),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update expense' });
  }
});

export default router;
