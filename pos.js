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

// GET low-stock / reorder alerts
router.get('/low-stock/:hotelId', authenticate, async (req, res) => {
  try {
    const items = await prisma.pOSInventory.findMany({
      where: {
        hotelId: req.params.hotelId,
        isAvailable: true,
      },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });

    const alerts = items
      .filter(item => item.stock <= item.reorderLevel)
      .map(item => ({
        ...item,
        status: item.stock === 0 ? 'OUT_OF_STOCK' : 'LOW_STOCK',
      }));

    res.json({ alerts, total: alerts.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch low stock alerts' });
  }
});

// UPDATE inventory item
router.put('/inventory/:id', authenticate, requireLevel(7), async (req, res) => {
  try {
    const { name, price, stock, isAvailable, unit, reorderLevel, category } = req.body;
    const item = await prisma.pOSInventory.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name }),
        ...(price !== undefined && { price: parseFloat(price) }),
        ...(stock !== undefined && { stock: parseInt(stock) }),
        ...(isAvailable !== undefined && { isAvailable }),
        ...(unit !== undefined && { unit }),
        ...(reorderLevel !== undefined && { reorderLevel: parseInt(reorderLevel) }),
        ...(category !== undefined && { category }),
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
    const { hotelId, name, category, price, stock, unit, reorderLevel } = req.body;
    const item = await prisma.pOSInventory.create({
      data: {
        hotelId: hotelId || req.user.hotelId,
        name,
        category: category || 'BAR',
        price: parseFloat(price),
        stock: parseInt(stock || 0),
        unit: unit || 'unit',
        reorderLevel: parseInt(reorderLevel || 5),
      },
    });
    res.status(201).json(item);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create inventory item' });
  }
});

// DELETE inventory item
router.delete('/inventory/:id', authenticate, requireLevel(7), async (req, res) => {
  try {
    await prisma.pOSInventory.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete inventory item' });
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

// CREATE POS sale — deducts stock from inventory
router.post('/sales', authenticate, requireLevel(3), async (req, res) => {
  try {
    const { hotelId, items, paymentType, roomLogId, notes } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'At least one item required' });
    }

    const saleHotelId = hotelId || req.user.hotelId;

    // Validate items & check stock
    let totalAmount = 0;
    const saleItems = [];

    for (const item of items) {
      const qty = parseInt(item.quantity);
      const price = parseFloat(item.unitPrice);
      const total = qty * price;
      totalAmount += total;

      // Check inventory stock if item has an id
      if (item.inventoryId) {
        const inv = await prisma.pOSInventory.findUnique({ where: { id: item.inventoryId } });
        if (inv && inv.stock < qty) {
          return res.status(400).json({
            error: `Insufficient stock for "${inv.name}". Available: ${inv.stock}, Requested: ${qty}`,
          });
        }
      }

      saleItems.push({
        name: item.name,
        category: item.category || 'BAR',
        quantity: qty,
        unitPrice: price,
        totalPrice: total,
        inventoryId: item.inventoryId || null,
      });
    }

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
          items: {
            create: saleItems.map(i => ({
              name: i.name,
              category: i.category,
              quantity: i.quantity,
              unitPrice: i.unitPrice,
              totalPrice: i.totalPrice,
            })),
          },
        },
        include: {
          items: true,
          staff: { select: { name: true } },
        },
      });

      // Deduct stock for each sold item
      for (const item of saleItems) {
        if (item.inventoryId) {
          await tx.pOSInventory.update({
            where: { id: item.inventoryId },
            data: { stock: { decrement: item.quantity } },
          });
        } else {
          // Try to match by name + hotelId
          const inv = await tx.pOSInventory.findFirst({
            where: { hotelId: saleHotelId, name: item.name },
          });
          if (inv && inv.stock > 0) {
            await tx.pOSInventory.update({
              where: { id: inv.id },
              data: { stock: { decrement: Math.min(item.quantity, inv.stock) } },
            });
          }
        }
      }

      // Record income transaction
      await tx.transaction.create({
        data: {
          hotelId: saleHotelId,
          roomLogId: roomLogId || null,
          type: 'INCOME',
          category: 'POS',
          amount: totalAmount,
          description: `POS Sale - ${saleItems.map(i => i.name).join(', ')}`,
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
            description: `Bar/Restaurant: ${saleItems.map(i => i.name).join(', ')}`,
          },
        });

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

    // Fetch updated inventory to return alerts
    const lowStockItems = await prisma.pOSInventory.findMany({
      where: {
        hotelId: saleHotelId,
        isAvailable: true,
        stock: { lte: prisma.pOSInventory.fields.reorderLevel },
      },
    });

    res.status(201).json({ ...result, lowStockAlerts: lowStockItems.length });
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
      include: { room: { select: { number: true, floor: true } } },
      select: {
        id: true,
        guestName: true,
        room: true,
        balance: true,
      },
    });
    res.json(rooms);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch active rooms' });
  }
});

export default router;
