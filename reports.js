import express from 'express';
import prisma from './prisma.js';
import { authenticate, requireLevel } from './middleware.js';

const router = express.Router();

// ── Financial Report with Period Filter ──────────────────────────────────────
router.get('/financial', authenticate, requireLevel(7), async (req, res) => {
  try {
    const { hotelId, period, startDate, endDate, groupBy = 'day' } = req.query;
    const resolvedHotelId = req.user.role !== 'SUPER_ADMIN' ? req.user.hotelId : hotelId;

    const { start, end } = resolvePeriod(period, startDate, endDate);

    const where = {
      hotelId: resolvedHotelId,
      createdAt: { gte: start, lte: end },
    };
    if (!resolvedHotelId) delete where.hotelId;

    const [income, expenses, transactions] = await Promise.all([
      prisma.transaction.aggregate({
        where: { ...where, type: 'INCOME' },
        _sum: { amount: true },
      }),
      prisma.transaction.aggregate({
        where: { ...where, type: 'EXPENSE' },
        _sum: { amount: true },
      }),
      prisma.transaction.findMany({
        where,
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    // Group by category
    const byCategory = {};
    transactions.forEach((t) => {
      if (!byCategory[t.category]) byCategory[t.category] = { income: 0, expense: 0 };
      if (t.type === 'INCOME') byCategory[t.category].income += Number(t.amount);
      else byCategory[t.category].expense += Number(t.amount);
    });

    // Group by date
    const byDate = {};
    transactions.forEach((t) => {
      const key = formatDateKey(new Date(t.createdAt), groupBy);
      if (!byDate[key]) byDate[key] = { income: 0, expense: 0, net: 0 };
      if (t.type === 'INCOME') byDate[key].income += Number(t.amount);
      else byDate[key].expense += Number(t.amount);
      byDate[key].net = byDate[key].income - byDate[key].expense;
    });

    const totalIncome = Number(income._sum.amount || 0);
    const totalExpenses = Number(expenses._sum.amount || 0);

    res.json({
      period: { start, end },
      summary: {
        totalIncome,
        totalExpenses,
        netRevenue: totalIncome - totalExpenses,
        transactionCount: transactions.length,
      },
      byCategory,
      byDate: Object.entries(byDate).map(([date, vals]) => ({ date, ...vals })),
    });
  } catch (err) {
    console.error('Financial report error:', err);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

// ── Occupancy Report ──────────────────────────────────────────────────────────
router.get('/occupancy', authenticate, requireLevel(7), async (req, res) => {
  try {
    const { hotelId, period, startDate, endDate } = req.query;
    const resolvedHotelId = req.user.role !== 'SUPER_ADMIN' ? req.user.hotelId : hotelId;
    const { start, end } = resolvePeriod(period, startDate, endDate);

    const where = {
      createdAt: { gte: start, lte: end },
    };
    if (resolvedHotelId) where.hotelId = resolvedHotelId;

    const [checkIns, checkOuts, hotel] = await Promise.all([
      prisma.roomLog.count({ where: { ...where, status: { not: 'CANCELLED' } } }),
      prisma.roomLog.count({ where: { ...where, status: 'CHECKED_OUT' } }),
      resolvedHotelId ? prisma.hotel.findUnique({
        where: { id: resolvedHotelId },
        include: { _count: { select: { rooms: true } } },
      }) : null,
    ]);

    const totalNights = await prisma.roomLog.aggregate({
      where: { ...where, status: { not: 'CANCELLED' } },
      _sum: { nights: true },
    });

    const avgRevPerBooking = await prisma.roomLog.aggregate({
      where: { ...where, status: { not: 'CANCELLED' } },
      _avg: { totalAmount: true },
    });

    const roomTypeBreakdown = await prisma.roomLog.groupBy({
      by: ['roomId'],
      where,
      _count: true,
    });

    res.json({
      period: { start, end },
      checkIns,
      checkOuts,
      totalNights: Number(totalNights._sum.nights || 0),
      avgNightsPerBooking: checkIns > 0
        ? Math.round((Number(totalNights._sum.nights || 0) / checkIns) * 10) / 10
        : 0,
      avgRevenuePerBooking: Math.round(Number(avgRevPerBooking._avg.totalAmount || 0)),
      totalRooms: hotel?._count?.rooms || 0,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate occupancy report' });
  }
});

// ── Monthly Balance Sheet ─────────────────────────────────────────────────────
router.get('/monthly-balance', authenticate, requireLevel(7), async (req, res) => {
  try {
    const { hotelId, year } = req.query;
    const resolvedHotelId = req.user.role !== 'SUPER_ADMIN' ? req.user.hotelId : hotelId;
    const targetYear = parseInt(year) || new Date().getUTCFullYear();

    const months = [];
    for (let month = 0; month < 12; month++) {
      const start = new Date(Date.UTC(targetYear, month, 1));
      const end = new Date(Date.UTC(targetYear, month + 1, 0, 23, 59, 59));

      const where = { createdAt: { gte: start, lte: end } };
      if (resolvedHotelId) where.hotelId = resolvedHotelId;

      const [income, expense] = await Promise.all([
        prisma.transaction.aggregate({ where: { ...where, type: 'INCOME' }, _sum: { amount: true } }),
        prisma.transaction.aggregate({ where: { ...where, type: 'EXPENSE' }, _sum: { amount: true } }),
      ]);

      const totalIncome = Number(income._sum.amount || 0);
      const totalExpense = Number(expense._sum.amount || 0);

      months.push({
        month: month + 1,
        monthName: new Date(Date.UTC(targetYear, month, 1)).toLocaleString('en', { month: 'long' }),
        totalIncome,
        totalExpense,
        netBalance: totalIncome - totalExpense,
      });
    }

    const yearTotal = months.reduce(
      (acc, m) => ({
        income: acc.income + m.totalIncome,
        expense: acc.expense + m.totalExpense,
        net: acc.net + m.netBalance,
      }),
      { income: 0, expense: 0, net: 0 }
    );

    res.json({ year: targetYear, months, yearTotal });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate balance sheet' });
  }
});

// ── POS Sales Summary ─────────────────────────────────────────────────────────
router.get('/pos-summary', authenticate, requireLevel(3), async (req, res) => {
  try {
    const { hotelId, period, startDate, endDate } = req.query;
    const resolvedHotelId = req.user.role !== 'SUPER_ADMIN' ? req.user.hotelId : hotelId;
    const { start, end } = resolvePeriod(period, startDate, endDate);

    const where = { createdAt: { gte: start, lte: end } };
    if (resolvedHotelId) where.hotelId = resolvedHotelId;

    const [total, byPayment, topItems] = await Promise.all([
      prisma.pOSSale.aggregate({ where, _sum: { totalAmount: true }, _count: true }),
      prisma.pOSSale.groupBy({ by: ['paymentType'], where, _sum: { totalAmount: true }, _count: true }),
      prisma.pOSSaleItem.groupBy({
        by: ['name', 'category'],
        where: { sale: where },
        _sum: { totalPrice: true, quantity: true },
        orderBy: { _sum: { totalPrice: 'desc' } },
        take: 10,
      }),
    ]);

    res.json({
      period: { start, end },
      totalRevenue: Number(total._sum.totalAmount || 0),
      totalTransactions: total._count,
      byPaymentType: byPayment,
      topItems,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate POS summary' });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function resolvePeriod(period, startDate, endDate) {
  const now = new Date();
  if (startDate && endDate) {
    return { start: new Date(startDate), end: new Date(endDate) };
  }
  switch (period) {
    case 'today':
      return {
        start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
        end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59)),
      };
    case 'week': {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - 7);
      return { start: d, end: now };
    }
    case 'year':
      return {
        start: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)),
        end: new Date(Date.UTC(now.getUTCFullYear(), 11, 31, 23, 59, 59)),
      };
    case 'month':
    default:
      return {
        start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
        end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59)),
      };
  }
}

function formatDateKey(date, groupBy) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  if (groupBy === 'month') return `${y}-${m}`;
  if (groupBy === 'year') return `${y}`;
  return `${y}-${m}-${d}`;
}

export default router;
