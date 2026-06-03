/**
 * roomLogs.js  – v2.3
 *
 * Changes in this version:
 * ─────────────────────────────────────────────────────────────────────────────
 *  • GET  /:id/balance         Live balance snapshot (accommodation + all POS
 *                              charges + extras − payments), callable at any time
 *                              so the front desk always sees the running total.
 *
 *  • POST /:id/payment         Extended to recalculate balance from the full
 *                              ledger (not just a delta) so concurrent charges
 *                              from bar/laundry never drift.
 *
 *  • POST /:id/checkout        Now auto-sends a receipt to the guest's email
 *                              (if on file) and stamps receiptSentAt on the log.
 *                              The final balance is recalculated from the ledger
 *                              at the moment of checkout so the printed total
 *                              is always accurate.
 *
 *  • GET  /search              GM-only guest / room search:
 *                                - Active stays: any staff level 5+
 *                                - Checked-out stays within 12 hrs: any staff 5+
 *                                - Checked-out stays BEYOND 12 hrs: level 7+ only
 *                              Searchable by guestName, guestEmail, or roomNumber.
 *
 *  • POST /:id/send-receipt    Manually send (or resend) a stay receipt by email.
 *                              Within 12 hrs of checkout: level 5+ allowed.
 *                              Beyond 12 hrs: level 7+ (GM) only.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import express             from 'express';
import { z }               from 'zod';

const checkInSchema = z.object({
  hotelId:       z.string().min(1, 'Hotel required'),
  roomId:        z.string().min(1, 'Room required'),
  guestName:     z.string().min(2, 'Guest name required').max(100),
  guestEmail:    z.string().email().optional().or(z.literal('')),
  guestPhone:    z.string().min(7).max(20).optional(),
  guestIdType:   z.string().max(30).optional(),
  guestIdNumber: z.string().max(50).optional(),
  checkInDate:   z.string().min(1, 'Check-in date required'),
  checkOutDate:  z.string().min(1, 'Check-out date required'),
  ratePerNight:  z.number().positive('Rate must be positive'),
  notes:         z.string().max(500).optional(),
  isReservation: z.boolean().optional(),
  depositPaid:   z.number().min(0).optional(),
  reservationRef: z.string().max(50).optional(),
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
import crypto              from 'crypto';
import prisma              from './prisma.js';
import { authenticate, requireLevel, requireHotelAccess } from './middleware.js';

const router = express.Router();

// ── Helper: sum all charges and payments into a single balance object ──────────
// Guarantees the displayed balance matches reality regardless of concurrent
// bar/laundry charges entered by other staff on the same stay.
async function computeLiveBalance(roomLogId) {
  const log = await prisma.roomLog.findUnique({
    where: { id: roomLogId },
    include: {
      hotel:       true,
      creditLedger: { orderBy: { date: 'asc' } },
      posSales: {
        include: { items: true },
        orderBy: { createdAt: 'asc' },
      },
      transactions: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!log) return null;

  // ── Accommodation base ────────────────────────────────────────────────────
  const ratePerNight    = Number(log.ratePerNight);
  const accommodationBase = ratePerNight * log.nights;

  // ── POS charges grouped by category ──────────────────────────────────────
  const posByCategory = {};
  let totalPOSCharges = 0;
  (log.posSales || []).forEach((sale) => {
    sale.items.forEach((item) => {
      if (!posByCategory[item.category]) posByCategory[item.category] = 0;
      posByCategory[item.category] += Number(item.totalPrice);
      totalPOSCharges += Number(item.totalPrice);
    });
  });

  // ── Approved extra charges (ROOM_EXTRAS transactions) ────────────────────
  const extraCharges = log.transactions
    .filter((t) => t.category === 'ROOM_EXTRAS' && t.type === 'INCOME')
    .reduce((s, t) => s + Number(t.amount), 0);

  // ── VAT ───────────────────────────────────────────────────────────────────
  const vatRate    = Number(log.hotel?.vatPercent ?? 7.5) / 100;
  const chargesBase = accommodationBase + totalPOSCharges + extraCharges;
  const vatAmount   = parseFloat((chargesBase * vatRate).toFixed(2));
  const grandTotal  = parseFloat((chargesBase + vatAmount).toFixed(2));

  // ── Total paid (sum of all CREDIT entries in ledger) ─────────────────────
  const totalPaid = log.creditLedger
    .filter((e) => e.type === 'CREDIT')
    .reduce((s, e) => s + Number(e.amount), 0);

  const balance = parseFloat((grandTotal - totalPaid).toFixed(2));

  return {
    roomLogId:        log.id,
    guestName:        log.guestName,
    roomNumber:       null,                   // filled below
    status:           log.status,
    breakdown: {
      accommodation:  accommodationBase,
      posByCategory,
      posTotal:       totalPOSCharges,
      extras:         extraCharges,
      chargesBase,
      vat:            vatAmount,
      vatPercent:     Number(log.hotel?.vatPercent ?? 7.5),
      grandTotal,
    },
    payments: {
      totalPaid,
      ledger: log.creditLedger,
    },
    balance,
    isOwing:          balance > 0,
    currency:         log.hotel?.currency || 'NGN',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /room-logs/search
// Search guest stays by guestName, guestEmail, or roomNumber.
// Access rules:
//   • ACTIVE stays                     → level 5+
//   • CHECKED_OUT within 12 hrs        → level 5+
//   • CHECKED_OUT beyond 12 hrs        → level 7+ (GM) only
// ─────────────────────────────────────────────────────────────────────────────
router.get('/search', authenticate, requireLevel(5), async (req, res) => {
  try {
    const { q, roomNumber, hotelId, page = 1, limit = 20 } = req.query;

    if (!q && !roomNumber) {
      return res.status(400).json({ error: 'Provide a search query (q) or roomNumber' });
    }

    const resolvedHotelId = req.user.role === 'SUPER_ADMIN'
      ? hotelId || undefined
      : req.user.hotelId;

    const where = { ...(resolvedHotelId ? { hotelId: resolvedHotelId } : {}) };

    // Build OR filter
    const orConditions = [];
    if (q) {
      orConditions.push(
        { guestName:  { contains: q, mode: 'insensitive' } },
        { guestEmail: { contains: q, mode: 'insensitive' } },
        { guestPhone: { contains: q, mode: 'insensitive' } },
        { guestIdNumber: { contains: q, mode: 'insensitive' } },
      );
    }
    if (roomNumber) {
      orConditions.push({ room: { number: { contains: roomNumber, mode: 'insensitive' } } });
    }
    if (orConditions.length) where.OR = orConditions;

    const logs = await prisma.roomLog.findMany({
      where,
      include: {
        room:       { select: { number: true, type: true, floor: true } },
        createdBy:  { select: { name: true } },
        posSales:   { include: { items: true }, orderBy: { createdAt: 'asc' } },
        creditLedger: { orderBy: { date: 'asc' } },
        hotel:      { select: { vatPercent: true, currency: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (parseInt(page) - 1) * parseInt(limit),
      take: parseInt(limit),
    });

    const now        = Date.now();
    const WINDOW_MS  = 12 * 60 * 60 * 1000; // 12 hours
    const isGM       = req.user.accessLevel >= 7;

    // Filter: staff below GM cannot see stays checked out more than 12 hrs ago
    const filtered = logs.filter((log) => {
      if (log.status === 'ACTIVE') return true;
      if (!log.checkedOutAt)       return isGM;
      const hoursSince = now - new Date(log.checkedOutAt).getTime();
      return hoursSince <= WINDOW_MS || isGM;
    });

    // Mark each result with whether the receipt window is still open
    const results = filtered.map((log) => {
      const checkedOutMs = log.checkedOutAt ? now - new Date(log.checkedOutAt).getTime() : 0;
      const receiptWindowOpen = log.status === 'ACTIVE' || checkedOutMs <= WINDOW_MS;

      // Strip guest email from response for staff below GM on old stays
      const safe = { ...log };
      if (!isGM && log.status === 'CHECKED_OUT' && checkedOutMs > WINDOW_MS) {
        safe.guestEmail = null;
        safe.guestPhone = null;
      }

      return { ...safe, receiptWindowOpen, gmRequired: !receiptWindowOpen };
    });

    res.json({
      results,
      total:    results.length,
      isGM,
    });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /  (existing list endpoint — unchanged except uses resolvedHotelId)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const { hotelId, roomId, status, guestName, startDate, endDate, page = 1, limit = 20 } = req.query;

    const where = {};
    if (req.user.role !== 'SUPER_ADMIN') where.hotelId = req.user.hotelId;
    else if (hotelId) where.hotelId = hotelId;

    if (roomId)    where.roomId    = roomId;
    if (status)    where.status    = status;
    if (guestName) where.guestName = { contains: guestName, mode: 'insensitive' };
    if (startDate && endDate) {
      where.createdAt = { gte: new Date(startDate), lte: new Date(endDate) };
    }

    const [logs, total] = await Promise.all([
      prisma.roomLog.findMany({
        where,
        include: {
          room:      { select: { number: true, type: true, floor: true } },
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id  (single log — unchanged)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/balance', authenticate, requireLevel(5), async (req, res) => {
  try {
    const snapshot = await computeLiveBalance(req.params.id);
    if (!snapshot) return res.status(404).json({ error: 'Room log not found' });

    // Attach room number
    const room = await prisma.roomLog.findUnique({
      where: { id: req.params.id },
      select: { room: { select: { number: true, floor: true, type: true } } },
    });
    snapshot.room = room?.room || null;

    res.json(snapshot);
  } catch (err) {
    console.error('Balance error:', err);
    res.status(500).json({ error: 'Failed to compute balance' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /  (check-in — unchanged logic, just surfaced for clarity)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/service-requests', authenticate, requireLevel(3), async (req, res) => {
  try {
    const { hotelId, status = 'PENDING' } = req.query;
    const targetHotelId = hotelId || req.user.hotelId;

    const requests = await prisma.guestServiceRequest.findMany({
      where: {
        hotelId: targetHotelId,
        ...(status !== 'ALL' ? { status } : {}),
      },
      include: {
        roomLog: { select: { guestName: true, room: { select: { number: true } } } },
        assignedTo: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json(requests);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch service requests' });
  }
});

// ── PATCH /service-requests/:id — Update request status with response time ───
router.patch('/service-requests/:id', authenticate, requireLevel(3), async (req, res) => {
  try {
    const { status, assignedToId } = req.body;
    const validStatuses = ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const existing = await prisma.guestServiceRequest.findUnique({
      where: { id: req.params.id },
    });
    if (!existing) return res.status(404).json({ error: 'Request not found' });

    const now = new Date();
    const updateData = {};

    if (status) updateData.status = status;
    if (assignedToId) {
      updateData.assignedToId = assignedToId;
      updateData.assignedAt = now;
    }

    // Track timing milestones
    if (status === 'IN_PROGRESS' && !existing.startedAt) {
      updateData.startedAt = now;
      // Auto-assign to current staff member if not assigned
      if (!existing.assignedToId) {
        updateData.assignedToId = req.user.id;
        updateData.assignedAt = now;
      }
    }

    if (status === 'COMPLETED') {
      updateData.completedAt = now;
      // Compute response time from request creation to completion
      const responseMinutes = Math.round(
        (now.getTime() - new Date(existing.createdAt).getTime()) / 60000
      );
      updateData.responseMinutes = responseMinutes;
    }

    const updated = await prisma.guestServiceRequest.update({
      where: { id: req.params.id },
      data: updateData,
      include: {
        roomLog: { select: { guestName: true, room: { select: { number: true } } } },
        assignedTo: { select: { id: true, name: true } },
      },
    });

    res.json(updated);
  } catch (err) {
    console.error('Service request update error:', err.message);
    res.status(500).json({ error: 'Failed to update request' });
  }
});
router.get('/:id', authenticate, async (req, res) => {
  try {
    const log = await prisma.roomLog.findUnique({
      where: { id: req.params.id },
      include: {
        room:         true,
        hotel:        true,
        createdBy:    { select: { id: true, name: true, email: true } },
        transactions: { orderBy: { createdAt: 'desc' } },
        creditLedger: { orderBy: { date:      'desc' } },
        posSales:     { include: { items: true }, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!log) return res.status(404).json({ error: 'Room log not found' });
    res.json(log);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch room log' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id/balance
// Live running balance for a stay — includes all POS charges so far.
// Front desk calls this whenever they need the current amount owed.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', authenticate, requireLevel(5), zodValidate(checkInSchema), async (req, res) => {
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

    const room = await prisma.room.findUnique({ where: { id: roomId } });
    if (!room)                       return res.status(404).json({ error: 'Room not found' });
    if (room.status === 'OCCUPIED')  return res.status(409).json({ error: 'Room is already occupied. Check-out first.' });
    if (room.status === 'MAINTENANCE') return res.status(409).json({ error: 'Room is under maintenance' });

    const checkIn  = new Date(checkInDate);
    const checkOut = new Date(checkOutDate);
    if (checkOut <= checkIn) return res.status(400).json({ error: 'Check-out must be after check-in' });

    const nights      = Math.ceil((checkOut - checkIn) / (1000 * 60 * 60 * 24));
    const rate        = parseFloat(ratePerNight);
    const totalAmount = nights * rate;
    const paid        = parseFloat(amountPaid || 0);
    const balance     = totalAmount - paid;

    const result = await prisma.$transaction(async (tx) => {
      // Generate unique QR token for guest portal
      const qrToken = crypto.randomBytes(16).toString('hex');

      const roomLog = await tx.roomLog.create({
        data: {
          hotelId, roomId,
          guestName, guestEmail, guestPhone, guestIdType, guestIdNumber,
          checkInDate: checkIn, checkOutDate: checkOut,
          nights, ratePerNight: rate,
          totalAmount, amountPaid: paid, balance,
          notes, createdById: req.user.id,
          qrToken, // unique token for guest portal QR code
        },
        include: { room: true },
      });

      await tx.room.update({ where: { id: roomId }, data: { status: 'OCCUPIED' } });

      if (paid > 0) {
        await tx.transaction.create({
          data: {
            hotelId, roomLogId: roomLog.id,
            type: 'INCOME', category: 'ROOM',
            amount: paid,
            description: `Check-in payment: ${guestName} - Room ${room.number}`,
            paymentMethod: paymentMethod || 'CASH',
          },
        });
        await tx.guestCreditLedger.create({
          data: { roomLogId: roomLog.id, type: 'CREDIT', amount: paid, description: 'Check-in payment' },
        });
      }

      return roomLog;
    });

    // Return with live balance + QR portal URL
    const liveBalance = await computeLiveBalance(result.id);
    const guestPortalUrl = `${process.env.FRONTEND_URL}/guest/${result.qrToken}`;
    // Generate QR code as base64 data URI — works offline, no external service
    let qrCodeDataUri = null;
    try {
      qrCodeDataUri = await QRCode.toDataURL(guestPortalUrl, {
        width: 256,
        margin: 2,
        color: { dark: '#1A3A5C', light: '#FFFFFF' },
        errorCorrectionLevel: 'M',
      });
    } catch (qrErr) {
      console.error('[QR Generation]', qrErr.message);
    }
    res.status(201).json({ ...result, liveBalance, guestPortalUrl, qrCodeDataUri });
  } catch (err) {
    console.error('Check-in error:', err);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Check-in failed' : err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /:id/payment
// Record a payment against a stay. Balance is re-derived from the full ledger
// so concurrent POS charges (bar, laundry) are always reflected accurately.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/payment', authenticate, requireLevel(5), async (req, res) => {
  try {
    const { amount, paymentMethod, description } = req.body;
    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Valid amount required' });
    }

    const log = await prisma.roomLog.findUnique({ where: { id: req.params.id } });
    if (!log)                          return res.status(404).json({ error: 'Room log not found' });
    if (log.status !== 'ACTIVE')       return res.status(400).json({ error: 'Room log is not active' });

    const paid = parseFloat(amount);

    // Record the payment entry
    await prisma.$transaction([
      prisma.guestCreditLedger.create({
        data: {
          roomLogId: log.id, type: 'CREDIT', amount: paid,
          description: description || 'Payment received',
        },
      }),
      prisma.transaction.create({
        data: {
          hotelId: log.hotelId, roomLogId: log.id,
          type: 'INCOME', category: 'ROOM',
          amount: paid,
          description: description || 'Room payment',
          paymentMethod: paymentMethod || 'CASH',
        },
      }),
    ]);

    // Now re-derive balance from the full ledger (not a delta)
    const liveBalance = await computeLiveBalance(log.id);

    // Persist the authoritative balance back to the record
    await prisma.roomLog.update({
      where: { id: log.id },
      data:  {
        amountPaid: liveBalance.payments.totalPaid,
        balance:    Math.max(0, liveBalance.balance),
        totalAmount: liveBalance.breakdown.grandTotal,
      },
    });

    res.json({ message: 'Payment recorded', liveBalance });
  } catch (err) {
    console.error('Payment error:', err);
    res.status(500).json({ error: 'Payment failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /:id/checkout
// Check out a guest. Final balance is computed from the full ledger.
// If the guest has an email on file, the receipt is automatically sent.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/checkout', authenticate, requireLevel(5), async (req, res) => {
  try {
    const { additionalCharges, paymentMethod, notes, sendReceipt = true } = req.body;

    const log = await prisma.roomLog.findUnique({
      where: { id: req.params.id },
      include: { room: true, hotel: true },
    });

    if (!log)                    return res.status(404).json({ error: 'Room log not found' });
    if (log.status !== 'ACTIVE') return res.status(400).json({ error: 'Room is not active' });

    const now   = new Date();
    const extra = parseFloat(additionalCharges || 0);

    // Record extra charges first (so the balance snapshot below includes them)
    if (extra > 0) {
      await prisma.transaction.create({
        data: {
          hotelId:       log.hotelId,
          roomLogId:     log.id,
          type:          'INCOME',
          category:      'ROOM_EXTRAS',
          amount:        extra,
          description:   'Check-out additional charges',
          paymentMethod: paymentMethod || 'CASH',
        },
      });
    }

    // Derive definitive balance from the full ledger
    const liveBalance = await computeLiveBalance(log.id);

    const finalBalance  = Math.max(0, liveBalance.balance);
    const finalTotal    = liveBalance.breakdown.grandTotal;
    const finalPaid     = liveBalance.payments.totalPaid;

    // Close the stay
    await prisma.$transaction(async (tx) => {
      await tx.roomLog.update({
        where: { id: log.id },
        data: {
          status:      'CHECKED_OUT',
          checkedOutAt: now,
          balance:     finalBalance,
          totalAmount: finalTotal,
          amountPaid:  finalPaid,
          notes:       notes ? `${log.notes || ''}\nCheckout: ${notes}` : log.notes,
        },
      });

      await tx.room.update({ where: { id: log.roomId }, data: { status: 'AVAILABLE' } });
    });

    // ── Auto-send receipt to guest email if available ──────────────────────
    let receiptResult = { sent: false, reason: 'No guest email on file' };
    if (sendReceipt && log.guestEmail) {
      try {
        const { sendRoomReceiptByLogId } = await import('./receipts.js');
        receiptResult = await sendRoomReceiptByLogId(log.id, log.guestEmail);
        if (receiptResult.sent) {
          await prisma.roomLog.update({
            where: { id: log.id },
            data:  { receiptSentAt: new Date() },
          });
        }
      } catch (emailErr) {
        console.error('[Checkout] Auto-email error:', emailErr.message);
        receiptResult = { sent: false, reason: emailErr.message };
      }
    }

    // NDPA 2023: set guest data retention expiry (2 years from checkout)
    const retainUntil = new Date(now.getTime() + 2 * 365 * 24 * 60 * 60 * 1000);
    await prisma.roomLog.update({
      where: { id: log.id },
      data: { retainUntil },
    });

    // Audit log — checkout event
    const { logAction, getIP, AUDIT_ACTIONS } = await import('./audit.js');
    logAction({
      userId: req.user.id, userName: req.user.name, userRole: req.user.role,
      hotelId: log.hotelId, action: AUDIT_ACTIONS.CHECKOUT,
      entityType: 'RoomLog', entityId: log.id,
      description: `${req.user.name} checked out ${log.guestName} from room ${log.room?.number}. Total: ₦${finalTotal.toLocaleString()}`,
      newValue: { guestName: log.guestName, room: log.room?.number, total: finalTotal, paid: finalPaid, balance: finalBalance },
      ipAddress: getIP(req),
    });

    res.json({
      message:         'Guest checked out successfully',
      checkedOutAt:    now,
      finalSummary: {
        totalCharges:  finalTotal,
        totalPaid:     finalPaid,
        balanceDue:    finalBalance,
        vatIncluded:   liveBalance.breakdown.vat,
      },
      receiptEmailed:  receiptResult.sent,
      receiptNote:     receiptResult.reason || (receiptResult.sent ? 'Receipt sent to ' + log.guestEmail : null),
    });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Checkout failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /:id/send-receipt
// Manually (re)send a stay receipt by email.
//
// Receipt window rules:
//   • ACTIVE stay          → level 5+  (receipt sent immediately)
//   • Checked out ≤ 12 hrs → level 5+  (receipt still within window)
//   • Checked out > 12 hrs → level 7+  (GM or above only)
//
// Body: { email: "override@example.com" }  — optional, uses guest email if omitted
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/send-receipt', authenticate, requireLevel(5), async (req, res) => {
  try {
    const log = await prisma.roomLog.findUnique({
      where: { id: req.params.id },
      select: {
        id: true, status: true, guestEmail: true, guestName: true,
        checkedOutAt: true, hotelId: true, receiptSentAt: true,
      },
    });
    if (!log) return res.status(404).json({ error: 'Room log not found' });

    // Hotel scope guard
    if (req.user.role !== 'SUPER_ADMIN' && log.hotelId !== req.user.hotelId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // ── Window check ─────────────────────────────────────────────────────────
    const WINDOW_MS   = 12 * 60 * 60 * 1000;
    const now         = Date.now();
    const isGM        = req.user.accessLevel >= 7;

    if (log.status === 'CHECKED_OUT' && log.checkedOutAt) {
      const elapsed = now - new Date(log.checkedOutAt).getTime();
      if (elapsed > WINDOW_MS && !isGM) {
        return res.status(403).json({
          error: 'Receipt window has expired (12 hrs after checkout). Only a General Manager or above can resend this receipt.',
          hoursElapsed: Math.round(elapsed / 3600000),
          gmRequired: true,
        });
      }
    }

    const recipientEmail = req.body.email || log.guestEmail;
    if (!recipientEmail) {
      return res.status(400).json({ error: 'No email address. Provide one in the request body or update the guest record.' });
    }

    const { sendRoomReceiptByLogId } = await import('./receipts.js');
    const result = await sendRoomReceiptByLogId(log.id, recipientEmail);

    if (result.sent) {
      await prisma.roomLog.update({
        where: { id: log.id },
        data:  { receiptSentAt: new Date() },
      });
    }

    res.json({
      sent:            result.sent,
      sentTo:          recipientEmail,
      error:           result.error || null,
      receiptSentAt:   result.sent ? new Date().toISOString() : log.receiptSentAt,
    });
  } catch (err) {
    console.error('Send receipt error:', err);
    res.status(500).json({ error: 'Failed to send receipt' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /:id  (update guest contact / notes)
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id', authenticate, requireLevel(5), async (req, res) => {
  try {
    const { notes, guestPhone, guestEmail } = req.body;
    const log = await prisma.roomLog.update({
      where: { id: req.params.id },
      data:  { notes, guestPhone, guestEmail },
    });
    res.json(log);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update log' });
  }
});

// Helper: normalize roomLog field names for frontend compatibility
function normalizeLog(log) {
  if (!log) return log;
  return {
    ...log,
    checkIn: log.checkIn || log.checkInDate,
    checkOut: log.checkOut || log.checkOutDate,
    checkInDate: log.checkIn || log.checkInDate,
    checkOutDate: log.checkOut || log.checkOutDate,
  };
}

export default router;

// ── GET /service-requests — Staff view of all pending guest requests ──────────
