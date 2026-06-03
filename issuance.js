/**
 * Stock Issuance Routes — Internal Use & Transfers
 * Tracks inventory issued for internal use (utilities, bar→kitchen, housekeeping, etc.)
 * Automatically deducts from inventory stock with full audit trail.
 */
import express from 'express';
import { z } from 'zod';
import prisma from './prisma.js';
import { authenticate, requireLevel, requireHotelAccess } from './middleware.js';

const router = express.Router();

const issuanceSchema = z.object({
  hotelId:      z.string().min(1),
  inventoryId:  z.string().min(1),
  quantity:     z.number().int().positive('Quantity must be a positive integer'),
  issuedToName: z.string().min(1).max(100, 'Recipient name too long'),
  purpose:      z.string().min(1).max(300, 'Purpose description too long'),
  category:     z.enum(['INTERNAL_USE','BAR_TRANSFER','KITCHEN','HOUSEKEEPING','MAINTENANCE','OTHER']).default('INTERNAL_USE'),
  notes:        z.string().max(500).optional(),
});

function zodValidate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten().fieldErrors });
    }
    req.body = result.data;
    next();
  };
}

// ── GET /api/issuance — List issuances for a hotel ────────────────────────────
router.get('/', authenticate, requireLevel(3), async (req, res) => {
  try {
    const { hotelId, inventoryId, category, from, to, limit = 50 } = req.query;

    const where = { hotelId };
    if (inventoryId) where.inventoryId = inventoryId;
    if (category)   where.category = category;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to)   where.createdAt.lte = new Date(to);
    }

    const [issuances, total] = await Promise.all([
      prisma.stockIssuance.findMany({
        where,
        include: {
          inventory: { select: { name: true, category: true, unit: true } },
          issuedBy:  { select: { name: true, role: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: Math.min(parseInt(limit), 200),
      }),
      prisma.stockIssuance.count({ where }),
    ]);

    res.json({ issuances, total });
  } catch (err) {
    console.error('[Issuance list]', err.message);
    res.status(500).json({ error: 'Failed to fetch issuances' });
  }
});

// ── GET /api/issuance/summary — Aggregate by category/item for a date range ──
router.get('/summary', authenticate, requireLevel(5), async (req, res) => {
  try {
    const { hotelId, from, to } = req.query;
    if (!hotelId) return res.status(400).json({ error: 'hotelId required' });

    const dateFilter = {};
    if (from) dateFilter.gte = new Date(from);
    if (to)   dateFilter.lte = new Date(to);

    const issuances = await prisma.stockIssuance.findMany({
      where: { hotelId, ...(Object.keys(dateFilter).length ? { createdAt: dateFilter } : {}) },
      include: { inventory: { select: { name: true, category: true, unit: true, price: true } } },
    });

    // Aggregate by category
    const byCategory = {};
    const byItem = {};
    for (const iss of issuances) {
      byCategory[iss.category] = (byCategory[iss.category] || 0) + iss.quantity;
      const key = iss.inventoryId;
      if (!byItem[key]) {
        byItem[key] = { name: iss.inventory.name, category: iss.inventory.category, unit: iss.inventory.unit, totalQty: 0, totalValue: 0 };
      }
      byItem[key].totalQty += iss.quantity;
      byItem[key].totalValue += iss.quantity * Number(iss.inventory.price || 0);
    }

    res.json({ byCategory, byItem: Object.values(byItem), totalIssuances: issuances.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate summary' });
  }
});

// ── POST /api/issuance — Issue stock (deducts from inventory) ─────────────────
router.post('/', authenticate, requireLevel(3), zodValidate(issuanceSchema), async (req, res) => {
  try {
    const { hotelId, inventoryId, quantity, issuedToName, purpose, category, notes } = req.body;

    // Fetch current inventory
    const item = await prisma.pOSInventory.findFirst({
      where: { id: inventoryId, hotelId },
    });
    if (!item) return res.status(404).json({ error: 'Inventory item not found' });
    if (item.stock < quantity) {
      return res.status(409).json({
        error: `Insufficient stock. Available: ${item.stock} ${item.unit}, Requested: ${quantity}`,
        available: item.stock,
      });
    }

    const stockBefore = item.stock;
    const stockAfter  = stockBefore - quantity;

    // Atomic: deduct stock + create issuance record
    const [, issuance] = await prisma.$transaction([
      prisma.pOSInventory.update({
        where: { id: inventoryId },
        data: { stock: stockAfter },
      }),
      prisma.stockIssuance.create({
        data: {
          hotelId,
          inventoryId,
          quantity,
          issuedToName,
          purpose,
          category,
          notes,
          issuedById: req.user.id,
          stockBefore,
          stockAfter,
        },
        include: {
          inventory: { select: { name: true, category: true, unit: true } },
          issuedBy:  { select: { name: true } },
        },
      }),
    ]);

    res.status(201).json({
      issuance,
      message: `Issued ${quantity} ${item.unit} of "${item.name}" to ${issuedToName}. Stock: ${stockBefore} → ${stockAfter}`,
    });
  } catch (err) {
    console.error('[Issuance create]', err.message);
    res.status(500).json({ error: 'Failed to process issuance' });
  }
});

// ── GET /api/issuance/:id — Single issuance detail ───────────────────────────
router.get('/:id', authenticate, requireLevel(3), async (req, res) => {
  try {
    const issuance = await prisma.stockIssuance.findUnique({
      where: { id: req.params.id },
      include: {
        inventory: { select: { name: true, category: true, unit: true, price: true } },
        issuedBy:  { select: { name: true, role: true } },
        hotel:     { select: { name: true } },
      },
    });
    if (!issuance) return res.status(404).json({ error: 'Issuance not found' });
    res.json(issuance);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch issuance' });
  }
});

export default router;
