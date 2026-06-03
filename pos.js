import express from 'express';
import { z } from 'zod';

const saleSchema = z.object({
  hotelId: z.string().min(1),
  items: z.array(z.object({
    name: z.string().min(1),
    category: z.enum(['BAR','RESTAURANT','LAUNDRY','OTHER']),
    quantity: z.number().int().positive(),
    unitPrice: z.number().positive(),
    totalPrice: z.number().positive(),
  })).min(1, 'At least one item required'),
  totalAmount: z.number().positive(),
  paymentType: z.enum(['CASH','CARD','TRANSFER','CHARGE_TO_ROOM']),
  roomLogId: z.string().optional(),
  chargedRoom: z.string().optional(),
  notes: z.string().max(500).optional(),
});

const inventorySchema = z.object({
  hotelId: z.string().min(1),
  name: z.string().min(1).max(100),
  category: z.enum(['BAR','RESTAURANT','LAUNDRY','OTHER']),
  price: z.number().positive(),
  stock: z.number().int().min(0).optional(),
  reorderLevel: z.number().int().min(0).optional(),
  unit: z.string().max(20).optional(),
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

// DELETE inventory item
router.delete('/inventory/:id', authenticate, requireLevel(7), async (req, res) => {
  try {
    await prisma.pOSInventory.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete inventory item' });
  }
});

// UPDATE inventory item
router.put('/inventory/:id', authenticate, requireLevel(7), async (req, res) => {
  try {
    const { name, price, stock, isAvailable, unit, category, reorderLevel } = req.body;
    const item = await prisma.pOSInventory.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name }),
        ...(price !== undefined && { price: parseFloat(price) }),
        ...(stock !== undefined && { stock: parseInt(stock) }),
        ...(isAvailable !== undefined && { isAvailable }),
        ...(unit !== undefined && { unit }),
        ...(category !== undefined && { category }),
        ...(reorderLevel !== undefined && { reorderLevel: parseInt(reorderLevel) }),
      },
    });
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update inventory' });
  }
});

// CREATE inventory item
router.post('/inventory', authenticate, zodValidate(inventorySchema), requireLevel(7), async (req, res) => {
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

// RESTOCK inventory item — safely increments stock using only schema fields
router.post('/inventory/:id/restock', authenticate, requireLevel(5), async (req, res) => {
  try {
    const { quantity } = req.body;
    const qty = parseInt(quantity);
    if (!qty || qty <= 0) return res.status(400).json({ error: 'Quantity must be a positive number' });

    const item = await prisma.pOSInventory.findUnique({ where: { id: req.params.id } });
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const updated = await prisma.pOSInventory.update({
      where: { id: req.params.id },
      data: { stock: { increment: qty } },
    });

    res.json({
      success: true,
      item: updated,
      restocked: qty,
      previousStock: item.stock,
      newStock: updated.stock,
    });
  } catch (err) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Restock failed' : err.message });
  }
});

// LOW STOCK alert — properly compares stock against each item's own reorderLevel
router.get('/low-stock/:hotelId', authenticate, async (req, res) => {
  try {
    // Fetch all available items, then filter in JS so we can compare per-item reorderLevel
    const items = await prisma.pOSInventory.findMany({
      where: { hotelId: req.params.hotelId, isAvailable: true },
      orderBy: { stock: 'asc' },
    });
    // Return items where current stock is at or below their individual reorder threshold
    const lowStock = items.filter(item => item.stock <= item.reorderLevel);
    res.json(lowStock);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch low-stock items' });
  }
});

// GROUP INVENTORY OVERVIEW — all inventory across all hotels in a group
// Super Admin: pass ?groupId=xxx  |  GROUP_MANAGER: auto-scoped to their group
router.get('/inventory-group', authenticate, requireLevel(8), async (req, res) => {
  try {
    let groupId = req.query.groupId;

    if (req.user.role === 'SUPER_ADMIN') {
      if (!groupId) return res.status(400).json({ error: 'groupId query param required for Super Admin' });
    } else {
      // GROUP_MANAGER: always scoped to their own group
      groupId = req.user.groupId;
    }

    const hotels = await prisma.hotel.findMany({
      where: { groupId },
      select: { id: true, name: true },
    });

    const hotelIds = hotels.map(h => h.id);
    const hotelMap = Object.fromEntries(hotels.map(h => [h.id, h.name]));

    const inventory = await prisma.pOSInventory.findMany({
      where: { hotelId: { in: hotelIds } },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });

    // Annotate each item with hotel name and low-stock flag
    const enriched = inventory.map(item => ({
      ...item,
      hotelName: hotelMap[item.hotelId] || 'Unknown',
      isLowStock: item.stock <= item.reorderLevel,
    }));

    // Summary: total items, low-stock count, out-of-stock count per hotel
    const summary = hotels.map(h => {
      const hotelItems = enriched.filter(i => i.hotelId === h.id);
      return {
        hotelId: h.id,
        hotelName: h.name,
        totalItems: hotelItems.length,
        lowStockCount: hotelItems.filter(i => i.isLowStock && i.stock > 0).length,
        outOfStockCount: hotelItems.filter(i => i.stock === 0).length,
      };
    });

    res.json({ inventory: enriched, summary, hotelCount: hotels.length });
  } catch (err) {
    console.error('Group inventory error:', err);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message });
  }
});

// ADJUST PRICE — managers can update price of their hotel's inventory items
// GENERAL_MANAGER (7): own hotel only  |  GROUP_MANAGER (8): any hotel in group  |  SUPER_ADMIN: any
router.patch('/inventory/:id/price', authenticate, requireLevel(7), async (req, res) => {
  try {
    const { price } = req.body;
    if (price === undefined || isNaN(parseFloat(price)) || parseFloat(price) < 0) {
      return res.status(400).json({ error: 'Valid price required' });
    }

    const item = await prisma.pOSInventory.findUnique({ where: { id: req.params.id } });
    if (!item) return res.status(404).json({ error: 'Item not found' });

    // Scope check
    if (req.user.role !== 'SUPER_ADMIN') {
      if (req.user.role === 'GROUP_MANAGER') {
        const hotel = await prisma.hotel.findUnique({ where: { id: item.hotelId } });
        if (!hotel || hotel.groupId !== req.user.groupId) {
          return res.status(403).json({ error: 'Item does not belong to your group' });
        }
      } else {
        // GENERAL_MANAGER: own hotel only
        if (item.hotelId !== req.user.hotelId) {
          return res.status(403).json({ error: 'Item does not belong to your hotel' });
        }
      }
    }

    const updated = await prisma.pOSInventory.update({
      where: { id: req.params.id },
      data: { price: parseFloat(price) },
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message });
  }
});

// GET POS sales
router.get('/sales', authenticate, async (req, res) => {
  try {
    const { hotelId, startDate, endDate, page = 1, limit = 20 } = req.query;
    const where = {};

    if (req.user.role === 'SUPER_ADMIN') {
      if (hotelId) where.hotelId = hotelId;
    } else if (req.user.role === 'GROUP_MANAGER') {
      // GM sees all hotels in their group
      const groupHotels = await prisma.hotel.findMany({
        where: { groupId: req.user.groupId },
        select: { id: true },
      });
      where.hotelId = { in: groupHotels.map(h => h.id) };
    } else {
      where.hotelId = req.user.hotelId;
    }

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
router.post('/sales', authenticate, zodValidate(saleSchema), requireLevel(3), async (req, res) => {
  try {
    const { hotelId, items, paymentType, roomLogId, notes } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'At least one item required' });
    }

    const saleHotelId = hotelId || req.user.hotelId;
    if (!saleHotelId) return res.status(400).json({ error: 'Hotel ID required' });

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

    if (paymentType === 'CHARGE_TO_ROOM' && !roomLogId) {
      return res.status(400).json({ error: 'Room log ID required for charge to room' });
    }

    const result = await prisma.$transaction(async (tx) => {
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

      // Deduct stock for each item sold
      for (const item of items) {
        if (item.inventoryId) {
          await tx.pOSInventory.update({
            where: { id: item.inventoryId },
            data: { stock: { decrement: parseInt(item.quantity) } },
          }).catch(() => {}); // ignore if item doesn't exist
        }
      }

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

      if (paymentType === 'CHARGE_TO_ROOM' && roomLogId) {
        await tx.guestCreditLedger.create({
          data: {
            roomLogId,
            type: 'DEBIT',
            amount: totalAmount,
            description: `Bar/Restaurant charge: ${saleItems.map((i) => i.name).join(', ')}`,
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

    res.status(201).json(result);
  } catch (err) {
    console.error('POS sale error:', err);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Sale failed' : err.message });
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
