/**
 * hotels.js  v6
 * Fixed: correct Prisma model names, dashboard returns proper field names,
 *        hotels can be moved between groups, full CRUD for Super Admin.
 */
import express from 'express';
import { z } from 'zod';

const hotelCreateSchema = z.object({
  name: z.string().min(2).max(100),
  address: z.string().max(300).optional(),
  phone: z.string().max(30).optional(),
  email: z.string().email().optional().or(z.literal('')),
  totalRooms: z.number().int().positive(),
  maxStaff: z.number().int().positive().optional(),
  vatPercent: z.number().min(0).max(100).optional(),
  currency: z.string().max(5).optional(),
  groupId: z.string().optional(),
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
import { authenticate, requireLevel, requireHotelAccess } from './middleware.js';

const router = express.Router();

// ── GET hotels ─────────────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    let where = {};
    if (req.user.role === 'SUPER_ADMIN') {
      const { groupId } = req.query;
      if (groupId) where.groupId = groupId;
    } else if (req.user.role === 'GROUP_MANAGER') {
      where.groupId = req.user.groupId;
    } else {
      where.id = req.user.hotelId;
    }

    const hotels = await prisma.hotel.findMany({
      where,
      include: {
        group: { select: { id: true, name: true, subscriptionExpiry: true, isActive: true } },
        _count: { select: { rooms: true, users: true, roomLogs: true } },
      },
      orderBy: [{ groupId: 'asc' }, { name: 'asc' }],
    });
    res.json(hotels);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch hotels' });
  }
});

// ── GET single hotel ───────────────────────────────────────────────────────────
router.get('/:id/dashboard', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    // Use aggregates instead of findMany for revenue/expenses — much faster
    const [
      roomStats,
      roomRevenueAgg,
      expenseAgg,
      posRevenueAgg,
      maintenanceOpen,
      maintenanceResolved,
      recentLogs,
    ] = await Promise.all([
      // Room stats via groupBy — single query instead of findMany+filter
      prisma.room.groupBy({
        by: ['status'],
        where: { hotelId: id },
        _count: { id: true },
      }),
      // Revenue aggregates — no row fetching, just sums
      prisma.roomLog.aggregate({
        where: { hotelId: id, createdAt: { gte: monthStart, lte: monthEnd } },
        _sum: { totalAmount: true },
      }),
      prisma.expense.aggregate({
        where: { hotelId: id, createdAt: { gte: monthStart, lte: monthEnd } },
        _sum: { amount: true },
      }),
      prisma.pOSSale.aggregate({
        where: { hotelId: id, createdAt: { gte: monthStart, lte: monthEnd } },
        _sum: { totalAmount: true },
      }),
      // Maintenance: only count open items (no date filter needed — small result set)
      prisma.maintenanceLog.count({
        where: { hotelId: id, status: { not: 'RESOLVED' } },
      }),
      // Average response time — only last 30 days of resolved tickets
      prisma.maintenanceLog.findMany({
        where: {
          hotelId: id,
          status: 'RESOLVED',
          resolvedAt: { not: null },
          createdAt: { gte: monthStart },
        },
        select: { createdAt: true, resolvedAt: true },
        take: 50, // cap at 50 for performance
      }),
      // Recent check-ins — last 5 active or recent checkouts
      prisma.roomLog.findMany({
        where: { hotelId: id },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true, guestName: true, checkInDate: true,
          checkOutDate: true, status: true, totalAmount: true,
          room: { select: { number: true, type: true } },
        },
      }),
    ]);

    // Build roomStats object from groupBy result
    const statusMap = {};
    roomStats.forEach((r) => { statusMap[r.status] = r._count.id; });
    const roomStatsObj = {
      total:       Object.values(statusMap).reduce((a, b) => a + b, 0),
      available:   statusMap['AVAILABLE']   || 0,
      occupied:    statusMap['OCCUPIED']    || 0,
      maintenance: statusMap['MAINTENANCE'] || 0,
      reserved:    statusMap['RESERVED']    || 0,
    };

    const roomRevenue   = Number(roomRevenueAgg._sum.totalAmount || 0);
    const posRevenue    = Number(posRevenueAgg._sum.totalAmount  || 0);
    const totalExpenses = Number(expenseAgg._sum.amount          || 0);

    // Also fetch the hotel's configured totalRooms to detect import mismatch
    const hotelInfo = await prisma.hotel.findUnique({
      where: { id },
      select: { totalRooms: true, name: true, currency: true, vatPercent: true }
    });

    const avgResponseTime = (Array.isArray(maintenanceResolved) && maintenanceResolved.length > 0)
      ? Math.round(maintenanceResolved.reduce((s, m) => {
          if (!m.resolvedAt || !m.createdAt) return s;
          return s + (new Date(m.resolvedAt).getTime() - new Date(m.createdAt).getTime()) / 60000;
        }, 0) / maintenanceResolved.length)
      : 0;

    res.json({
      hotelInfo,
      roomStats: roomStatsObj,
      occupancyRate: roomStatsObj.total > 0 ? Math.round((roomStatsObj.occupied / roomStatsObj.total) * 100) : 0,
      activeBookings: roomStatsObj.occupied,
      roomRevenue,
      posRevenue,
      totalExpenses,
      netRevenue: roomRevenue + posRevenue - totalExpenses,
      monthlyIncome: roomRevenue + posRevenue,
      monthlyExpenses: totalExpenses,
      maintenanceOpen,
      avgResponseTime,
      recentLogs,
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

router.get('/:id', authenticate, requireHotelAccess('id'), async (req, res) => {
  try {
    const hotel = await prisma.hotel.findUnique({
      where: { id: req.params.id },
      include: {
        group: { select: { id: true, name: true, subscriptionExpiry: true, supportPhone: true } },
        rooms: { orderBy: [{ floor: 'asc' }, { number: 'asc' }] },
        _count: { select: { rooms: true, users: true } },
      },
    });
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' });
    if (!['GENERAL_MANAGER', 'GROUP_MANAGER', 'SUPER_ADMIN'].includes(req.user.role)) {
      if (hotel.group) delete hotel.group.supportPhone;
    }
    res.json(hotel);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch hotel' });
  }
});

// ── CREATE hotel ───────────────────────────────────────────────────────────────
router.post('/', authenticate, requireLevel(8), zodValidate(hotelCreateSchema), async (req, res) => {
  try {
    const { name, address, phone, email, totalRooms, currency, timezone, groupId, vatPercent } = req.body;
    if (!name || !totalRooms) return res.status(400).json({ error: 'Name and total rooms are required' });

    let targetGroupId = null;
    if (req.user.role === 'SUPER_ADMIN') {
      targetGroupId = groupId || null;
    } else if (req.user.role === 'GROUP_MANAGER') {
      targetGroupId = req.user.groupId;
    }

    const hotel = await prisma.hotel.create({
      data: {
        name, address, phone, email,
        totalRooms: parseInt(totalRooms),
        currency: currency || 'NGN',
        timezone: timezone || 'UTC',
        groupId: targetGroupId,
        vatPercent: vatPercent !== undefined ? parseFloat(vatPercent) : 7.5,
      },
    });
    res.status(201).json(hotel);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create hotel' });
  }
});

// ── UPDATE hotel ───────────────────────────────────────────────────────────────
router.put('/:id', authenticate, requireLevel(7), requireHotelAccess('id'), async (req, res) => {
  try {
    const { name, address, phone, email, currency, timezone, totalRooms, maxStaff, vatPercent, groupId, isActive } = req.body;
    const data = {};
    if (name !== undefined) data.name = name;
    if (address !== undefined) data.address = address;
    if (phone !== undefined) data.phone = phone;
    if (email !== undefined) data.email = email;
    if (currency !== undefined) data.currency = currency;
    if (timezone !== undefined) data.timezone = timezone;
    if (isActive !== undefined && req.user.accessLevel >= 8) data.isActive = isActive;
    if (totalRooms !== undefined && req.user.accessLevel >= 7) data.totalRooms = parseInt(totalRooms);
    if (maxStaff !== undefined && req.user.accessLevel >= 7) data.maxStaff = parseInt(maxStaff);
    if (vatPercent !== undefined && req.user.accessLevel >= 7) {
      const vat = parseFloat(vatPercent);
      if (isNaN(vat) || vat < 0 || vat > 100) return res.status(400).json({ error: 'vatPercent must be 0–100' });
      data.vatPercent = vat;
    }
    // Only Super Admin can move a hotel between groups
    if (groupId !== undefined && req.user.role === 'SUPER_ADMIN') {
      data.groupId = groupId || null;
    }

    const hotel = await prisma.hotel.update({ where: { id: req.params.id }, data });
    res.json(hotel);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update hotel' });
  }
});

// ── DELETE hotel (Super Admin only) ───────────────────────────────────────────
router.delete('/:id', authenticate, requireLevel(10), async (req, res) => {
  try {
    // Check for active guests first
    const activeGuests = await prisma.roomLog.count({ where: { hotelId: req.params.id, status: 'ACTIVE' } });
    if (activeGuests > 0) return res.status(409).json({ error: `Cannot delete: ${activeGuests} active guest(s) checked in` });
    await prisma.hotel.delete({ where: { id: req.params.id } });
    res.json({ message: 'Hotel deleted' });
  } catch (err) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message });
  }
});

// ── Hotel Dashboard ───────────────────────────────────────────────────────────
// Returns: roomStats, occupancyRate, roomRevenue, posRevenue, totalExpenses,
//          netRevenue, activeBookings, maintenanceOpen, recentCheckIns
// ── POST /api/hotels/:id/logo — Upload hotel logo (Super Admin only) ──────────
// Accepts base64-encoded image in body: { logo: "data:image/png;base64,..." }
// Best format: PNG or JPEG, max 500KB, square or wide (recommended 400×200px)
router.post('/:id/logo', authenticate, requireLevel(10), async (req, res) => {
  try {
    const { logo } = req.body;
    if (!logo) return res.status(400).json({ error: 'Logo data required' });
    // Validate: must be base64 image (PNG or JPEG only)
    if (!logo.startsWith('data:image/png;base64,') && !logo.startsWith('data:image/jpeg;base64,') && !logo.startsWith('data:image/jpg;base64,')) {
      return res.status(400).json({ error: 'Only PNG or JPEG images are accepted' });
    }
    // Validate: max 500KB (base64 overhead ~33%, so 500KB image = ~670KB base64)
    const sizeKB = Math.round((logo.length * 3/4) / 1024);
    if (sizeKB > 500) {
      return res.status(400).json({ error: `Image too large (${sizeKB}KB). Maximum size is 500KB. Recommended: 400×200px PNG.` });
    }
    if (!logo) return res.status(400).json({ error: 'No logo provided' });
    // Validate: must be a base64 data URI of an image
    if (!logo.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Logo must be a PNG or JPEG image' });
    }
    const base64Data = logo.split(',')[1] || '';
    const sizeBytes = Math.ceil(base64Data.length * 0.75);
    if (sizeBytes > 600 * 1024) {
      return res.status(400).json({ error: 'Logo must be under 500KB. Current size: ' + Math.round(sizeBytes/1024) + 'KB' });
    }
    const mimeMatch = logo.match(/^data:(image\/[a-zA-Z]+);base64,/);
    const allowedTypes = ['image/png','image/jpeg','image/jpg','image/webp'];
    if (!mimeMatch || !allowedTypes.includes(mimeMatch[1])) {
      return res.status(400).json({ error: 'Logo must be PNG, JPEG, or WebP format' });
    }

    // Validate it's a base64 image
    const match = logo.match(/^data:(image\/(png|jpeg|jpg|webp));base64,/);
    if (!match) {
      return res.status(400).json({
        error: 'Invalid format. Upload PNG, JPEG, or WebP as base64.',
        hint: 'Best format: PNG, max 500KB, 400×200px recommended',
      });
    }

    // Check size (base64 string length ÷ 1.37 ≈ actual bytes)
    const estimatedBytes = (logo.length * 0.75);
    if (estimatedBytes > 600 * 1024) {
      return res.status(400).json({ error: 'Logo too large. Maximum size is 500KB.' });
    }

    const hotel = await prisma.hotel.findUnique({ where: { id: req.params.id } });
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' });

    // Store the base64 logo directly in the database (logoUrl field)
    await prisma.hotel.update({
      where: { id: req.params.id },
      data: { logoUrl: logo },
    });

    res.json({ message: 'Logo uploaded successfully', logoUrl: logo.substring(0, 50) + '...' });
  } catch (err) {
    console.error('Logo upload error:', err);
    res.status(500).json({ error: 'Failed to upload logo' });
  }
});

// ── DELETE /api/hotels/:id/logo — Remove hotel logo (Super Admin only) ────────
router.delete('/:id/logo', authenticate, requireLevel(10), async (req, res) => {
  try {
    await prisma.hotel.update({
      where: { id: req.params.id },
      data: { logoUrl: null },
    });
    res.json({ message: 'Logo removed' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove logo' });
  }
});

export default router;
