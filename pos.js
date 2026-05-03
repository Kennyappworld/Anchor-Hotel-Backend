import express from 'express';
import prisma from './prisma.js';
import { authenticate, requireLevel } from './middleware.js';

const router = express.Router();

// GET POS inventory
router.get('/inventory/:hotelId', authenticate, async (req, res) => {
  try {
    const { category } = req.query;
    const where = { hotelId: req.params.hotelId, isAvailable: true };
    if (category) where.category = category;

    const items = await prisma.pOSInventory.findMany({
      where,
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
});

// UPDATE inventory item
router.put('/inventory/:id', authenticate, requireLevel(7), async (req, res) => {
  try {
    const { name, price, stock, isAvailable, unit } = req.body;
    const item = await prisma.pOSInventory.update({
      where: { id: req.params.id },
      data: {
        name,
        price: price ? parseFloat(price) : undefined,
        stock: stock !== undefined ? parseInt(stock) : undefined,
        isAvailable,
        unit,
      },
    });
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update inventory' });
  }
});

// CREATE inventory item
router.post('/inventory', authenticate, requireLevel(7), async (req, res) => {
  try {
    const { hotelId, name, category, price, stock, unit } = req.body;
    const item = await prisma.pOSInventory.create({
      data: {
        hotelId: hotelId || req.user.hotelId,
        name,
        category: category || 'BAR',
        price: parseFloat(price),
        stock: parseInt(stock || 0),
        unit: unit || 'unit',
      },
    });
    res.status(201).json(item);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create inventory item' });
  }
});

// GET POS sales
router.get('/sales', authenticate, async (req, res) => {
  try {
    const { hotelId, startDate, endDate, page = 1, limit = 20 } = req.query;
    const where = {};

    if (req.user.role !== 'SUPER_ADMIN') where.hotelId = req.user.hotelId;
    else if (hotelId) where.hotelId = hotelId;

    if (startDate && endDate) {
      where.createdAt = { gte: new Date(startDate), lte: new Date(endDate) };
    }

    const [sales, total] = await Promise.all([
      prisma.pOSSale.findMany({
        where,
        include: {
          items: true,
          staff: { select: { name: true } },
          roomLog: { select: { guestName: true, room: { select: { number: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit),
      }),
      prisma.pOSSale.count({ where }),
    ]);

    res.json({ sales, total, pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch sales' });
  }
});

// CREATE POS sale
router.post('/sales', authenticate, requireLevel(3), async (req, res) => {
  try {
    const { hotelId, items, paymentType, roomLogId, notes } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'At least one item required' });
    }

    const saleHotelId = hotelId || req.user.hotelId;

    // Calculate totals and validate
    let totalAmount = 0;
    const saleItems = items.map((item) => {
      const qty = parseInt(item.quantity);
      const price = parseFloat(item.unitPrice);
      const total = qty * price;
      totalAmount += total;
      return {
        name: item.name,
        category: item.category || 'BAR',
        quantity: qty,
        unitPrice: price,
        totalPrice: total,
      };
    });

    // If charge to room, verify room log exists
    if (paymentType === 'CHARGE_TO_ROOM' && !roomLogId) {
      return res.status(400).json({ error: 'Room log ID required for charge to room' });
    }

    const result = await prisma.$transaction(async (tx) => {
      // Create sale
      const sale = await tx.pOSSale.create({
        data: {
          hotelId: saleHotelId,
          totalAmount,
          paymentType: paymentType || 'CASH',
          roomLogId: roomLogId || null,
          staffId: req.user.id,
          notes,
          items: { create: saleItems },
        },
        include: {
          items: true,
          staff: { select: { name: true } },
        },
      });

      // Record income transaction
      await tx.transaction.create({
        data: {
          hotelId: saleHotelId,
          roomLogId: roomLogId || null,
          type: 'INCOME',
          category: 'POS',
          amount: totalAmount,
          description: `POS Sale - ${saleItems.map((i) => i.name).join(', ')}`,
          paymentMethod: paymentType || 'CASH',
          reference: sale.id,
        },
      });

      // If charge to room, add to ledger
      if (paymentType === 'CHARGE_TO_ROOM' && roomLogId) {
        await tx.guestCreditLedger.create({
          data: {
            roomLogId,
            type: 'DEBIT',
            amount: totalAmount,
            description: `Bar/Restaurant charge: ${saleItems.map((i) => i.name).join(', ')}`,
          },
        });

        // Update room log balance
        const log = await tx.roomLog.findUnique({ where: { id: roomLogId } });
        await tx.roomLog.update({
          where: { id: roomLogId },
          data: {
            balance: Number(log.balance) + totalAmount,
            totalAmount: Number(log.totalAmount) + totalAmount,
          },
        });
      }

      return sale;
    });

    res.status(201).json(result);
  } catch (err) {
    console.error('POS sale error:', err);
    res.status(500).json({ error: 'Sale failed: ' + err.message });
  }
});

// GET active room logs for charge-to-room lookup
router.get('/active-rooms/:hotelId', authenticate, requireLevel(3), async (req, res) => {
  try {
    const rooms = await prisma.roomLog.findMany({
      where: { hotelId: req.params.hotelId, status: 'ACTIVE' },
      include: { room: { select: { number: true, floor: true, customName: true } } },
      orderBy: { checkInDate: 'desc' },
    });
    res.json(rooms);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch active rooms' });
  }
});

export default router;
