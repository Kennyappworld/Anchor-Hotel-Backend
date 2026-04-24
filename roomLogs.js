import express from 'express';
import prisma from './prisma.js';
import { authenticate, requireLevel, requireHotelAccess } from './middleware.js';

const router = express.Router();

// GET room logs with filters
router.get('/', authenticate, async (req, res) => {
  try {
    const {
      hotelId, roomId, status, guestName,
      startDate, endDate, page = 1, limit = 20
    } = req.query;

    const where = {};
    if (req.user.role !== 'SUPER_ADMIN') where.hotelId = req.user.hotelId;
    else if (hotelId) where.hotelId = hotelId;

    if (roomId) where.roomId = roomId;
    if (status) where.status = status;
    if (guestName) where.guestName = { contains: guestName, mode: 'insensitive' };
    if (startDate && endDate) {
      where.createdAt = {
        gte: new Date(startDate),
        lte: new Date(endDate),
      };
    }

    const [logs, total] = await Promise.all([
      prisma.roomLog.findMany({
        where,
        include: {
          room: { select: { number: true, type: true, floor: true } },
          createdBy: { select: { name: true } },
          transactions: { take: 5, orderBy: { createdAt: 'desc' } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit),
      }),
      prisma.roomLog.count({ where }),
    ]);

    res.json({ logs, total, pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) {
    console.error('Room logs error:', err);
    res.status(500).json({ error: 'Failed to fetch room logs' });
  }
});

// GET single room log
router.get('/:id', authenticate, async (req, res) => {
  try {
    const log = await prisma.roomLog.findUnique({
      where: { id: req.params.id },
      include: {
        room: true,
        createdBy: { select: { id: true, name: true, email: true } },
        transactions: { orderBy: { createdAt: 'desc' } },
        creditLedger: { orderBy: { date: 'desc' } },
        posSales: { include: { items: true }, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!log) return res.status(404).json({ error: 'Room log not found' });
    res.json(log);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch room log' });
  }
});

// ── THE GATEKEEPER PROTOCOL ───────────────────────────────────────────────────
// Create room log AND mark room as Occupied atomically
router.post('/', authenticate, requireLevel(5), async (req, res) => {
  try {
    const {
      hotelId, roomId,
      guestName, guestEmail, guestPhone, guestIdType, guestIdNumber,
      checkInDate, checkOutDate, ratePerNight, amountPaid,
      paymentMethod, notes,
    } = req.body;

    if (!hotelId || !roomId || !guestName || !checkInDate || !checkOutDate || !ratePerNight) {
      return res.status(400).json({
        error: 'Missing required fields: hotelId, roomId, guestName, checkInDate, checkOutDate, ratePerNight',
      });
    }

    // Verify room exists and is available
    const room = await prisma.room.findUnique({ where: { id: roomId } });
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.status === 'OCCUPIED') {
      return res.status(409).json({ error: 'Room is already occupied. Check-out first.' });
    }
    if (room.status === 'MAINTENANCE') {
      return res.status(409).json({ error: 'Room is under maintenance' });
    }

    const checkIn = new Date(checkInDate);
    const checkOut = new Date(checkOutDate);

    if (checkOut <= checkIn) {
      return res.status(400).json({ error: 'Check-out must be after check-in' });
    }

    // Calculate nights
    const nights = Math.ceil((checkOut - checkIn) / (1000 * 60 * 60 * 24));
    const rate = parseFloat(ratePerNight);
    const totalAmount = nights * rate;
    const paid = parseFloat(amountPaid || 0);
    const balance = totalAmount - paid;

    // Use transaction to ensure atomicity (The Gatekeeper Protocol)
    const result = await prisma.$transaction(async (tx) => {
      // 1. Create the room log
      const roomLog = await tx.roomLog.create({
        data: {
          hotelId,
          roomId,
          guestName,
          guestEmail,
          guestPhone,
          guestIdType,
          guestIdNumber,
          checkInDate: checkIn,
          checkOutDate: checkOut,
          nights,
          ratePerNight: rate,
          totalAmount,
          amountPaid: paid,
          balance,
          notes,
          createdById: req.user.id,
        },
        include: { room: true },
      });

      // 2. Change room status to OCCUPIED
      await tx.room.update({
        where: { id: roomId },
        data: { status: 'OCCUPIED' },
      });

      // 3. Record payment transaction if amount paid
      if (paid > 0) {
        await tx.transaction.create({
          data: {
            hotelId,
            roomLogId: roomLog.id,
            type: 'INCOME',
            category: 'ROOM',
            amount: paid,
            description: `Check-in payment: ${guestName} - Room ${room.number}`,
            paymentMethod: paymentMethod || 'CASH',
          },
        });

        // 4. Add to credit ledger
        await tx.guestCreditLedger.create({
          data: {
            roomLogId: roomLog.id,
            type: 'CREDIT',
            amount: paid,
            description: 'Check-in payment',
          },
        });
      }

      return roomLog;
    });

    res.status(201).json(result);
  } catch (err) {
    console.error('Check-in error:', err);
    res.status(500).json({ error: 'Check-in failed: ' + err.message });
  }
});

// Add payment to room log (Credit Ledger)
router.post('/:id/payment', authenticate, requireLevel(5), async (req, res) => {
  try {
    const { amount, paymentMethod, description } = req.body;
    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Valid amount required' });
    }

    const log = await prisma.roomLog.findUnique({ where: { id: req.params.id } });
    if (!log) return res.status(404).json({ error: 'Room log not found' });
    if (log.status !== 'ACTIVE') {
      return res.status(400).json({ error: 'Room log is not active' });
    }

    const paid = parseFloat(amount);
    const newAmountPaid = Number(log.amountPaid) + paid;
    const newBalance = Number(log.totalAmount) - newAmountPaid;

    await prisma.$transaction([
      prisma.roomLog.update({
        where: { id: log.id },
        data: { amountPaid: newAmountPaid, balance: Math.max(0, newBalance) },
      }),
      prisma.guestCreditLedger.create({
        data: {
          roomLogId: log.id,
          type: 'CREDIT',
          amount: paid,
          description: description || 'Additional payment',
        },
      }),
      prisma.transaction.create({
        data: {
          hotelId: log.hotelId,
          roomLogId: log.id,
          type: 'INCOME',
          category: 'ROOM',
          amount: paid,
          description: description || 'Additional room payment',
          paymentMethod: paymentMethod || 'CASH',
        },
      }),
    ]);

    const updatedLog = await prisma.roomLog.findUnique({
      where: { id: log.id },
      include: { creditLedger: { orderBy: { date: 'desc' } } },
    });

    res.json(updatedLog);
  } catch (err) {
    res.status(500).json({ error: 'Payment failed' });
  }
});

// CHECK-OUT
router.post('/:id/checkout', authenticate, requireLevel(5), async (req, res) => {
  try {
    const { additionalCharges, paymentMethod, notes } = req.body;
    const log = await prisma.roomLog.findUnique({
      where: { id: req.params.id },
      include: { room: true },
    });

    if (!log) return res.status(404).json({ error: 'Room log not found' });
    if (log.status !== 'ACTIVE') {
      return res.status(400).json({ error: 'Room is not active' });
    }

    const now = new Date();
    const extra = parseFloat(additionalCharges || 0);

    await prisma.$transaction(async (tx) => {
      // Update log
      await tx.roomLog.update({
        where: { id: log.id },
        data: {
          status: 'CHECKED_OUT',
          checkedOutAt: now,
          balance: Math.max(0, Number(log.balance) - extra),
          notes: notes ? `${log.notes || ''}\nCheckout: ${notes}` : log.notes,
        },
      });

      // Mark room as available
      await tx.room.update({
        where: { id: log.roomId },
        data: { status: 'AVAILABLE' },
      });

      // Record extra charges if any
      if (extra > 0) {
        await tx.transaction.create({
          data: {
            hotelId: log.hotelId,
            roomLogId: log.id,
            type: 'INCOME',
            category: 'ROOM_EXTRAS',
            amount: extra,
            description: 'Check-out additional charges',
            paymentMethod: paymentMethod || 'CASH',
          },
        });
      }
    });

    res.json({ message: 'Guest checked out successfully', checkedOutAt: now });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Checkout failed' });
  }
});

// UPDATE room log notes (Level 5+)
router.patch('/:id', authenticate, requireLevel(5), async (req, res) => {
  try {
    const { notes, guestPhone, guestEmail } = req.body;
    const log = await prisma.roomLog.update({
      where: { id: req.params.id },
      data: { notes, guestPhone, guestEmail },
    });
    res.json(log);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update log' });
  }
});

export default router;
