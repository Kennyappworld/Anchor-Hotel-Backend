import express from 'express';
import prisma from './prisma.js';
import { authenticate, requireLevel, requireHotelAccess } from './middleware.js';

const router = express.Router();

// GET all hotels (Super Admin) or own hotel
router.get('/', authenticate, async (req, res) => {
  try {
    const where = req.user.role === 'SUPER_ADMIN' ? {} : { id: req.user.hotelId };
    const hotels = await prisma.hotel.findMany({
      where,
      include: {
        _count: { select: { rooms: true, users: true, roomLogs: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(hotels);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch hotels' });
  }
});

// GET single hotel
router.get('/:id', authenticate, requireHotelAccess('id'), async (req, res) => {
  try {
    const hotel = await prisma.hotel.findUnique({
      where: { id: req.params.id },
      include: {
        rooms: { orderBy: [{ floor: 'asc' }, { number: 'asc' }] },
        _count: { select: { rooms: true, users: true } },
      },
    });
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' });
    res.json(hotel);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch hotel' });
  }
});

// CREATE hotel (Super Admin only)
router.post('/', authenticate, requireLevel(10), async (req, res) => {
  try {
    const { name, address, phone, email, totalRooms, currency, timezone } = req.body;
    if (!name || !totalRooms) {
      return res.status(400).json({ error: 'Name and total rooms are required' });
    }

    const hotel = await prisma.hotel.create({
      data: { name, address, phone, email, totalRooms: parseInt(totalRooms), currency, timezone },
    });
    res.status(201).json(hotel);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create hotel' });
  }
});

// UPDATE hotel
router.put('/:id', authenticate, requireLevel(7), requireHotelAccess('id'), async (req, res) => {
  try {
    const { name, address, phone, email, currency, timezone } = req.body;
    // Only Super Admin can update totalRooms
    const data = { name, address, phone, email, currency, timezone };
    if (req.user.role === 'SUPER_ADMIN' && req.body.totalRooms) {
      data.totalRooms = parseInt(req.body.totalRooms);
    }

    const hotel = await prisma.hotel.update({
      where: { id: req.params.id },
      data,
    });
    res.json(hotel);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update hotel' });
  }
});

// DELETE hotel (Super Admin only)
router.delete('/:id', authenticate, requireLevel(10), async (req, res) => {
  try {
    await prisma.hotel.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });
    res.json({ message: 'Hotel deactivated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete hotel' });
  }
});

// GET hotel KPIs / dashboard stats
router.get('/:id/dashboard', authenticate, requireHotelAccess('id'), async (req, res) => {
  try {
    const { id } = req.params;
    const now = new Date();
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const endOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59));

    const [
      rooms,
      activeBookings,
      monthlyIncome,
      monthlyExpenses,
      maintenanceOpen,
      maintenanceLogs,
      recentLogs,
    ] = await Promise.all([
      prisma.room.findMany({ where: { hotelId: id } }),
      prisma.roomLog.count({ where: { hotelId: id, status: 'ACTIVE' } }),
      prisma.transaction.aggregate({
        where: { hotelId: id, type: 'INCOME', createdAt: { gte: startOfMonth, lte: endOfMonth } },
        _sum: { amount: true },
      }),
      prisma.transaction.aggregate({
        where: { hotelId: id, type: 'EXPENSE', createdAt: { gte: startOfMonth, lte: endOfMonth } },
        _sum: { amount: true },
      }),
      prisma.maintenanceLog.count({ where: { hotelId: id, status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
      prisma.maintenanceLog.findMany({
        where: { hotelId: id, status: 'RESOLVED', resolvedAt: { not: null } },
        select: { createdAt: true, resolvedAt: true },
      }),
      prisma.roomLog.findMany({
        where: { hotelId: id },
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: { room: true },
      }),
    ]);

    // Calculate Average Response Time (ART) in minutes
    let avgResponseTime = 0;
    if (maintenanceLogs.length > 0) {
      const totalMinutes = maintenanceLogs.reduce((sum, log) => {
        const diff = (new Date(log.resolvedAt) - new Date(log.createdAt)) / 60000;
        return sum + diff;
      }, 0);
      avgResponseTime = Math.round(totalMinutes / maintenanceLogs.length);
    }

    const roomStats = {
      total: rooms.length,
      available: rooms.filter((r) => r.status === 'AVAILABLE').length,
      occupied: rooms.filter((r) => r.status === 'OCCUPIED').length,
      maintenance: rooms.filter((r) => r.status === 'MAINTENANCE').length,
      reserved: rooms.filter((r) => r.status === 'RESERVED').length,
    };

    const occupancyRate = rooms.length > 0
      ? Math.round((roomStats.occupied / rooms.length) * 100)
      : 0;

    const income = Number(monthlyIncome._sum.amount || 0);
    const expenses = Number(monthlyExpenses._sum.amount || 0);

    res.json({
      roomStats,
      occupancyRate,
      activeBookings,
      monthlyIncome: income,
      monthlyExpenses: expenses,
      netRevenue: income - expenses,
      maintenanceOpen,
      avgResponseTime,
      recentLogs,
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

export default router;
