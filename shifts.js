/**
 * shifts.js  v20
 * 
 * Shift management and handover reporting.
 * 
 * Workflow:
 *   1. Front desk staff opens a shift at start of duty (POST /open)
 *   2. During shift: normal operations tracked via other routes
 *   3. At end of duty: staff closes shift (POST /:id/close)
 *      → System auto-generates a handover summary snapshot
 *   4. Incoming staff can view the last closed shift summary before starting
 * 
 * Access:
 *   - Level 5+ (STAFF_FRONTDESK): open/close own shifts, view current
 *   - Level 7+  (GENERAL_MANAGER): view all shifts, export reports
 */

import express from 'express';
import prisma  from './prisma.js';
import { authenticate, requireLevel } from './middleware.js';

const router = express.Router();

// ── POST /api/shifts/open — Open a new shift ──────────────────────────────────
router.post('/open', authenticate, requireLevel(5), async (req, res) => {
  try {
    const { hotelId, notes } = req.body;
    const resolvedHotelId = hotelId || req.user.hotelId;

    if (!resolvedHotelId) {
      return res.status(400).json({ error: 'Hotel ID required' });
    }

    // Check if this hotel already has an open shift
    const existing = await prisma.shift.findFirst({
      where: { hotelId: resolvedHotelId, status: 'OPEN' },
      include: { hotel: { select: { name: true } } },
    });

    if (existing) {
      return res.status(409).json({
        error: `A shift is already open for this hotel (opened at ${new Date(existing.openedAt).toLocaleString('en-NG')})`,
        existingShift: existing,
      });
    }

    const shift = await prisma.shift.create({
      data: {
        hotelId: resolvedHotelId,
        openedById: req.user.id,
        status: 'OPEN',
        notes: notes || null,
      },
      include: {
        hotel: { select: { id: true, name: true } },
      },
    });

    res.status(201).json(shift);
  } catch (err) {
    console.error('[Shift Open]', err.message);
    res.status(500).json({ error: 'Failed to open shift' });
  }
});

// ── POST /api/shifts/:id/close — Close shift with snapshot ────────────────────
router.post('/:id/close', authenticate, requireLevel(5), async (req, res) => {
  try {
    const { notes } = req.body;
    const shift = await prisma.shift.findUnique({ where: { id: req.params.id } });
    if (!shift) return res.status(404).json({ error: 'Shift not found' });
    if (shift.status === 'CLOSED') return res.status(409).json({ error: 'Shift already closed' });

    const now = new Date();
    const shiftStart = new Date(shift.openedAt);
    const hotelId = shift.hotelId;

    // Generate handover snapshot
    const [checkIns, checkOuts, posSales, expenses, openLogs] = await Promise.all([
      prisma.roomLog.count({ where: { hotelId, createdAt: { gte: shiftStart, lte: now } } }),
      prisma.roomLog.count({ where: { hotelId, checkedOutAt: { gte: shiftStart, lte: now } } }),
      prisma.pOSSale.findMany({ where: { hotelId, createdAt: { gte: shiftStart, lte: now } }, select: { totalAmount: true } }),
      prisma.expense.findMany({ where: { hotelId, status: 'APPROVED', createdAt: { gte: shiftStart, lte: now } }, select: { amount: true } }),
      prisma.roomLog.findMany({
        where: { hotelId, status: 'ACTIVE' },
        select: { id: true, guestName: true, balance: true, checkOutDate: true, room: { select: { number: true } } },
      }),
    ]);

    // Revenue during shift
    const posRevenue = posSales.reduce((s, p) => s + Number(p.totalAmount), 0);
    const expTotal   = expenses.reduce((s, e) => s + Number(e.amount), 0);
    const pendBal    = openLogs.reduce((s, l) => s + Number(l.balance || 0), 0);

    // Room revenue from checkouts during shift
    const checkoutLogs = await prisma.roomLog.findMany({
      where: { hotelId, checkedOutAt: { gte: shiftStart, lte: now } },
      select: { amountPaid: true },
    });
    const roomRevenue = checkoutLogs.reduce((s, l) => s + Number(l.amountPaid || 0), 0);

    const closed = await prisma.shift.update({
      where: { id: req.params.id },
      data: {
        closedById:     req.user.id,
        closedAt:       now,
        status:         'CLOSED',
        totalCheckIns:  checkIns,
        totalCheckOuts: checkOuts,
        totalRevenue:   roomRevenue,
        totalPosRevenue: posRevenue,
        totalExpenses:  expTotal,
        openRoomsCount: openLogs.length,
        pendingBalance: pendBal,
        notes:          notes || shift.notes,
      },
      include: {
        hotel: { select: { id: true, name: true } },
      },
    });

    // Identify overdue checkouts (past checkout date but still active)
    const overdueGuests = openLogs.filter(l => new Date(l.checkOutDate) < now);

    res.json({
      shift: closed,
      handover: {
        summary: {
          shiftDuration: Math.round((now - shiftStart) / 60000) + ' minutes',
          checkIns,
          checkOuts,
          roomRevenue,
          posRevenue,
          totalRevenue: roomRevenue + posRevenue,
          totalExpenses: expTotal,
          netRevenue: roomRevenue + posRevenue - expTotal,
          openRooms: openLogs.length,
          pendingBalance: pendBal,
        },
        openRooms: openLogs.map(l => ({
          guestName: l.guestName,
          room: l.room?.number,
          balance: l.balance,
          checkOutDate: l.checkOutDate,
          isOverdue: new Date(l.checkOutDate) < now,
        })),
        overdueCount: overdueGuests.length,
        message: overdueGuests.length > 0
          ? `⚠️ ${overdueGuests.length} guest(s) overdue checkout — inform incoming staff`
          : '✅ No overdue checkouts',
      },
    });
  } catch (err) {
    console.error('[Shift Close]', err.message);
    res.status(500).json({ error: 'Failed to close shift' });
  }
});

// ── GET /api/shifts/current — Current open shift for this hotel ───────────────
router.get('/current', authenticate, requireLevel(5), async (req, res) => {
  try {
    const hotelId = req.query.hotelId || req.user.hotelId;
    if (!hotelId) return res.status(400).json({ error: 'Hotel ID required' });

    const shift = await prisma.shift.findFirst({
      where: { hotelId, status: 'OPEN' },
      orderBy: { openedAt: 'desc' },
    });

    if (!shift) return res.json({ open: false, shift: null });

    // Live stats since shift opened
    const shiftStart = new Date(shift.openedAt);
    const now = new Date();
    const [checkIns, checkOuts, posSales, openLogs] = await Promise.all([
      prisma.roomLog.count({ where: { hotelId, createdAt: { gte: shiftStart } } }),
      prisma.roomLog.count({ where: { hotelId, checkedOutAt: { gte: shiftStart } } }),
      prisma.pOSSale.findMany({ where: { hotelId, createdAt: { gte: shiftStart } }, select: { totalAmount: true } }),
      prisma.roomLog.findMany({
        where: { hotelId, status: 'ACTIVE' },
        select: { guestName: true, balance: true, checkOutDate: true, room: { select: { number: true } } },
      }),
    ]);

    const posRevenue = posSales.reduce((s, p) => s + Number(p.totalAmount), 0);
    const overdueCount = openLogs.filter(l => new Date(l.checkOutDate) < now).length;

    res.json({
      open: true,
      shift,
      liveStats: {
        checkIns,
        checkOuts,
        posRevenue,
        openRooms: openLogs.length,
        overdueCount,
        duration: Math.round((now - shiftStart) / 60000),
      },
      openRooms: openLogs,
    });
  } catch (err) {
    console.error('[Shift Current]', err.message);
    res.status(500).json({ error: 'Failed to get current shift' });
  }
});

// ── GET /api/shifts — List all shifts for this hotel ─────────────────────────
router.get('/', authenticate, requireLevel(7), async (req, res) => {
  try {
    const hotelId = req.query.hotelId || req.user.hotelId;
    const { page = 1, limit = 20 } = req.query;

    const shifts = await prisma.shift.findMany({
      where: { hotelId },
      orderBy: { openedAt: 'desc' },
      take: parseInt(limit),
      skip: (parseInt(page) - 1) * parseInt(limit),
    });

    res.json(shifts);
  } catch (err) {
    res.status(500).json({ error: 'Failed to list shifts' });
  }
});

// ── GET /api/shifts/:id — Get single shift with full handover detail ──────────
router.get('/:id', authenticate, requireLevel(5), async (req, res) => {
  try {
    const shift = await prisma.shift.findUnique({
      where: { id: req.params.id },
      include: { hotel: { select: { id: true, name: true } } },
    });
    if (!shift) return res.status(404).json({ error: 'Shift not found' });
    res.json(shift);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get shift' });
  }
});

export default router;
