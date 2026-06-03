/**
 * guestPortal.js — Public guest-facing API (NO authentication required)
 * 
 * These routes are accessed via QR code scan by hotel guests on their phones.
 * Security: all routes are scoped to a single roomLog via qrToken.
 * Rate limited to prevent abuse.
 * 
 * GET  /api/guest/:qrToken           — Get stay info, hotel info, menu
 * POST /api/guest/:qrToken/order     — Place food/drink order (charges to room)
 * POST /api/guest/:qrToken/request   — Request service (housekeeping, maintenance)
 * GET  /api/guest/:qrToken/bill      — View current bill
 * POST /api/guest/:qrToken/checkout-request — Request checkout
 */

import express from 'express';
import rateLimit from 'express-rate-limit';

const guestPortalLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,  // 10 minutes
  max: 60,
  message: { error: 'Too many requests from this device. Please try again in 10 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});
import prisma from './prisma.js';
import { logAction, AUDIT_ACTIONS } from './audit.js';

const router = express.Router();

// Guest portal rate limit — 60 requests per minute per IP
const guestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests. Please wait a moment.' },
});

router.use(guestLimiter);

// ── Validate qrToken and get stay ─────────────────────────────────────────────
async function getActiveStay(qrToken) {
  const log = await prisma.roomLog.findUnique({
    where: { qrToken },
    include: {
      room:  { select: { number: true, type: true, floor: true, amenities: true } },
      hotel: { select: { name: true, phone: true, email: true, logoUrl: true, vatPercent: true, currency: true } },
    },
  });

  if (!log) return null;
  if (log.status !== 'ACTIVE') return null; // portal only works during active stay

  return log;
}

// ── GET /api/guest/:qrToken — Stay overview + menu ───────────────────────────
router.get('/:qrToken', async (req, res) => {
  try {
    const log = await getActiveStay(req.params.qrToken);
    if (!log) return res.status(404).json({ error: 'Invalid or expired QR code' });

    // Get hotel menu (available POS inventory)
    const menuItems = await prisma.pOSInventory.findMany({
      where: {
        hotelId: log.hotelId,
        isAvailable: true,
        stock: { gt: 0 },
        category: { in: ['BAR', 'RESTAURANT'] },
      },
      select: { id: true, name: true, category: true, price: true, unit: true },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });

    // Get pending/recent service requests
    const recentRequests = await prisma.guestServiceRequest.findMany({
      where: { roomLogId: log.id, status: { not: 'CANCELLED' } },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    // Compute current balance
    const transactions = await prisma.transaction.aggregate({
      where: { roomLogId: log.id, type: 'INCOME' },
      _sum: { amount: true },
    });
    const payments = await prisma.guestCreditLedger.aggregate({
      where: { roomLogId: log.id, type: 'PAYMENT' },
      _sum: { amount: true },
    });

    res.json({
      stay: {
        guestName:    log.guestName,
        roomNumber:   log.room.number,
        roomType:     log.room.type,
        checkInDate:  log.checkInDate,
        checkOutDate: log.checkOutDate,
        nights:       log.nights,
        status:       log.status,
      },
      hotel: {
        name:    log.hotel.name,
        phone:   log.hotel.phone,
        email:   log.hotel.email,
        logoUrl: log.hotel.logoUrl,
      },
      menu: {
        bar:        menuItems.filter(i => i.category === 'BAR'),
        restaurant: menuItems.filter(i => i.category === 'RESTAURANT'),
      },
      bill: {
        roomRate:      Number(log.ratePerNight),
        nights:        log.nights,
        totalCharges:  Number(log.totalAmount),
        totalPaid:     Number(payments._sum.amount || 0),
        balance:       Number(log.balance),
      },
      recentRequests: recentRequests.map(r => ({
        id:        r.id,
        type:      r.type,
        status:    r.status,
        notes:     r.notes,
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    console.error('Guest portal error:', err.message);
    res.status(500).json({ error: 'Service temporarily unavailable' });
  }
});

// ── POST /api/guest/:qrToken/order — Place food/drink order ──────────────────
router.post('/:qrToken/order', async (req, res) => {
  try {
    const log = await getActiveStay(req.params.qrToken);
    if (!log) return res.status(404).json({ error: 'Invalid or expired QR code' });

    const { items, notes } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No items selected' });
    }

    // Validate all items exist and have stock
    let totalAmount = 0;
    const validatedItems = [];

    for (const item of items) {
      const inv = await prisma.pOSInventory.findFirst({
        where: {
          id: item.id,
          hotelId: log.hotelId,
          isAvailable: true,
          stock: { gte: item.qty || 1 },
        },
      });

      if (!inv) {
        return res.status(400).json({ error: `${item.name || 'Item'} is no longer available` });
      }

      const qty = Math.max(1, Math.min(10, parseInt(item.qty) || 1)); // cap at 10 per item
      const lineTotal = Number(inv.price) * qty;
      totalAmount += lineTotal;
      validatedItems.push({ id: inv.id, name: inv.name, price: Number(inv.price), qty, lineTotal });
    }

    // Create service request
    const request = await prisma.guestServiceRequest.create({
      data: {
        roomLogId:   log.id,
        hotelId:     log.hotelId,
        type:        'FOOD_ORDER',
        items:       validatedItems,
        notes:       notes || null,
        status:      'PENDING',
        totalAmount,
      },
    });

    // Create POS sale (charge to room)
    await prisma.pOSSale.create({
      data: {
        hotelId:     log.hotelId,
        staffId:     null, // guest self-order
        roomLogId:   log.id,
        totalAmount,
        paymentType: 'ROOM_CHARGE',
        notes:       `Room service order by guest (QR) — Room ${log.room.number}`,
        items: {
          create: validatedItems.map(i => ({
            inventoryId: i.id,
            name:        i.name,
            quantity:    i.qty,
            unitPrice:   i.price,
            totalPrice:  i.lineTotal,
          })),
        },
      },
    });

    // Deduct stock
    for (const item of validatedItems) {
      await prisma.pOSInventory.update({
        where: { id: item.id },
        data:  { stock: { decrement: item.qty } },
      });
    }

    res.status(201).json({
      message: 'Your order has been received! Our team will bring it to your room shortly.',
      requestId:   request.id,
      totalAmount,
      items:       validatedItems,
      estimatedTime: '15–25 minutes',
    });
  } catch (err) {
    console.error('Guest order error:', err.message);
    res.status(500).json({ error: 'Failed to place order. Please call reception.' });
  }
});

// ── POST /api/guest/:qrToken/request — Service request ───────────────────────
router.post('/:qrToken/request', async (req, res) => {
  try {
    const log = await getActiveStay(req.params.qrToken);
    if (!log) return res.status(404).json({ error: 'Invalid or expired QR code' });

    const { type, notes } = req.body;
    const validTypes = ['HOUSEKEEPING', 'EXTRA_TOWELS', 'MAINTENANCE', 'WAKE_UP_CALL', 'DO_NOT_DISTURB', 'CHECKOUT_REQUEST', 'OTHER'];

    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: 'Invalid request type' });
    }

    // Check for duplicate pending request of same type
    const existing = await prisma.guestServiceRequest.findFirst({
      where: { roomLogId: log.id, type, status: 'PENDING' },
    });
    if (existing) {
      return res.json({ message: 'Your request is already being processed. We\'ll be with you shortly!' });
    }

    const request = await prisma.guestServiceRequest.create({
      data: {
        roomLogId: log.id,
        hotelId:   log.hotelId,
        type,
        notes:     notes || null,
        status:    'PENDING',
      },
    });

    const messages = {
      HOUSEKEEPING:     'Housekeeping will visit your room shortly.',
      EXTRA_TOWELS:     'Extra towels are on their way!',
      MAINTENANCE:      'Our maintenance team has been notified.',
      WAKE_UP_CALL:     'Wake-up call request received.',
      DO_NOT_DISTURB:   'Do Not Disturb noted. We won\'t disturb you.',
      CHECKOUT_REQUEST: 'Checkout request received. Reception will prepare your bill.',
      OTHER:            'Your request has been received. Our team will attend to you.',
    };

    res.status(201).json({
      message:   messages[type] || 'Request received.',
      requestId: request.id,
    });
  } catch (err) {
    console.error('Guest request error:', err.message);
    res.status(500).json({ error: 'Failed to submit request. Please call reception.' });
  }
});

// ── GET /api/guest/:qrToken/bill — View detailed bill ────────────────────────
router.get('/:qrToken/bill', async (req, res) => {
  try {
    const log = await getActiveStay(req.params.qrToken);
    if (!log) return res.status(404).json({ error: 'Invalid or expired QR code' });

    const [posSales, transactions, payments] = await Promise.all([
      prisma.pOSSale.findMany({
        where: { roomLogId: log.id },
        include: { items: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.transaction.findMany({
        where: { roomLogId: log.id, type: 'INCOME' },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.guestCreditLedger.findMany({
        where: { roomLogId: log.id, type: 'PAYMENT' },
        orderBy: { date: 'asc' },
      }),
    ]);

    const roomCharges = Number(log.ratePerNight) * log.nights;
    const posCharges = posSales.reduce((s, sale) => s + Number(sale.totalAmount), 0);
    const extraCharges = transactions
      .filter(t => t.category === 'ROOM_EXTRAS')
      .reduce((s, t) => s + Number(t.amount), 0);
    const totalPaid = payments.reduce((s, p) => s + Number(p.amount), 0);
    const grandTotal = roomCharges + posCharges + extraCharges;
    const balance = Math.max(0, grandTotal - totalPaid);

    res.json({
      guestName:    log.guestName,
      roomNumber:   log.room.number,
      hotelName:    log.hotel.name,
      checkInDate:  log.checkInDate,
      checkOutDate: log.checkOutDate,
      charges: {
        roomCharges,
        posCharges,
        extraCharges,
        grandTotal,
        vatAmount: grandTotal * (Number(log.hotel.vatPercent) / 100),
      },
      payments: {
        totalPaid,
        balance,
      },
      breakdown: {
        roomNights: { nights: log.nights, rate: Number(log.ratePerNight), total: roomCharges },
        roomServiceOrders: posSales.map(s => ({
          date:  s.createdAt,
          items: s.items.map(i => ({ name: i.name, qty: i.quantity, price: Number(i.unitPrice), total: Number(i.totalPrice) })),
          total: Number(s.totalAmount),
        })),
      },
    });
  } catch (err) {
    console.error('Guest bill error:', err.message);
    res.status(500).json({ error: 'Failed to load bill' });
  }
});

export default router;

// ── POST /api/guest/:qrToken/feedback — Overall stay feedback (from QR portal) 
router.post('/:qrToken/feedback', async (req, res) => {
  try {
    const { overallRating, overallComment } = req.body;
    const log = await prisma.roomLog.findUnique({ where: { qrToken: req.params.qrToken } });
    if (!log) return res.status(404).json({ error: 'Invalid QR code' });

    const existing = await prisma.guestFeedback.findFirst({
      where: { roomLogId: log.id, overallRating: { not: null } },
    });
    if (existing) return res.json({ message: 'Feedback already submitted. Thank you!' });

    await prisma.guestFeedback.create({
      data: {
        roomLogId: log.id, hotelId: log.hotelId,
        overallRating: overallRating ? parseInt(overallRating) : null,
        overallComment: overallComment?.trim() || null,
      },
    });
    res.json({ message: 'Thank you for your feedback! 🙏' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

// ── POST /api/guest/:qrToken/rate/:requestId — Rate a completed service request
router.post('/:qrToken/rate/:requestId', async (req, res) => {
  try {
    const { rating, comment } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1-5' });

    const request = await prisma.guestServiceRequest.findUnique({
      where: { id: req.params.requestId },
      include: { roomLog: true },
    });
    if (!request || request.roomLog?.qrToken !== req.params.qrToken) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (request.guestRating) return res.json({ message: 'Already rated!' });

    await prisma.guestServiceRequest.update({
      where: { id: req.params.requestId },
      data: { guestRating: parseInt(rating), guestComment: comment?.trim() || null },
    });
    res.json({ message: 'Rating submitted. Thank you!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to submit rating' });
  }
});
