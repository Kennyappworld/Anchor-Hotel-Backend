import express from 'express';
import prisma from './prisma.js';
import { authenticate, requireLevel } from './middleware.js';

const router = express.Router();

// ALL backup routes are Super Admin only — enforced at middleware level
// requireLevel(10) prevents any non-SUPER_ADMIN from reaching any route in this file
router.use(authenticate, requireLevel(10));

// ── Super Admin Analytics ─────────────────────────────────────────────────────
router.get('/analytics', async (req, res) => {
  try {
    const [allHotels, allGroups, allRooms, allUsers] = await Promise.all([
      prisma.hotel.findMany({ include: { rooms: true } }),
      prisma.hotelGroup.findMany({ include: { hotels: { include: { rooms: true } } } }),
      prisma.room.findMany(),
      prisma.user.findMany({ select: { id: true, role: true, hotelId: true } }),
    ]);

    const occupiedRooms = allRooms.filter(r => r.status === 'OCCUPIED').length;
    const availableRooms = allRooms.filter(r => r.status === 'AVAILABLE').length;
    const maintenanceRooms = allRooms.filter(r => r.status === 'MAINTENANCE').length;

    const hotelAnalytics = allHotels.map(hotel => ({
      id: hotel.id,
      name: hotel.name,
      address: hotel.address,
      totalRooms: hotel.rooms.length,
      occupiedRooms: hotel.rooms.filter(r => r.status === 'OCCUPIED').length,
      availableRooms: hotel.rooms.filter(r => r.status === 'AVAILABLE').length,
      maintenanceRooms: hotel.rooms.filter(r => r.status === 'MAINTENANCE').length,
      occupancyRate: hotel.rooms.length > 0
        ? Math.round((hotel.rooms.filter(r => r.status === 'OCCUPIED').length / hotel.rooms.length) * 100)
        : 0,
      staffCount: allUsers.filter(u => u.hotelId === hotel.id).length,
    }));

    const groupAnalytics = allGroups.map(group => {
      const groupRooms = group.hotels.flatMap(h => h.rooms);
      return {
        id: group.id,
        name: group.name,
        hotelCount: group.hotels.length,
        totalRooms: groupRooms.length,
        occupiedRooms: groupRooms.filter(r => r.status === 'OCCUPIED').length,
        occupancyRate: groupRooms.length > 0
          ? Math.round((groupRooms.filter(r => r.status === 'OCCUPIED').length / groupRooms.length) * 100)
          : 0,
      };
    });

    res.json({
      summary: {
        totalHotels: allHotels.length,
        totalRooms: allRooms.length,
        totalUsers: allUsers.length,
        occupiedRooms,
        availableRooms,
        maintenanceRooms,
        occupancyRate: allRooms.length > 0 ? Math.round((occupiedRooms / allRooms.length) * 100) : 0,
      },
      hotelAnalytics,
      groupAnalytics,
    });
  } catch (err) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message });
  }
});

// ── Full Data Backup ──────────────────────────────────────────────────────────
router.get('/export', async (req, res) => {
  try {
    const { startDate, endDate, hotelId } = req.query;
    const dateFilter = {};
    if (startDate) dateFilter.gte = new Date(startDate);
    if (endDate) dateFilter.lte = new Date(endDate + 'T23:59:59Z');
    const createdAt = Object.keys(dateFilter).length ? dateFilter : undefined;
    const hotelFilter = hotelId ? { hotelId } : {};

    const [groups, hotels, rooms, roomLogs, expenses, posTransactions, posInventory, maintenance, users] =
      await Promise.all([
        prisma.hotelGroup.findMany(),
        prisma.hotel.findMany({ where: hotelId ? { id: hotelId } : {} }),
        prisma.room.findMany({ where: hotelFilter }),
        prisma.roomLog.findMany({ where: { ...hotelFilter, ...(createdAt ? { createdAt } : {}) } }),
        prisma.expense.findMany({ where: { ...hotelFilter, ...(createdAt ? { createdAt } : {}) } }),
        prisma.pOSTransaction.findMany({ where: { ...hotelFilter, ...(createdAt ? { createdAt } : {}) } }),
        prisma.pOSInventory.findMany({ where: hotelFilter }),
        prisma.maintenanceRequest.findMany({ where: { ...hotelFilter, ...(createdAt ? { createdAt } : {}) } }),
        prisma.user.findMany({
          select: { id: true, email: true, name: true, role: true, accessLevel: true, isVerified: true, hotelId: true, createdAt: true },
          where: hotelId ? { hotelId } : {},
        }),
      ]);

    const backup = {
      metadata: { exportedAt: new Date().toISOString(), version: '1.0', filters: { startDate, endDate, hotelId } },
      data: { groups, hotels, rooms, roomLogs, expenses, posTransactions, posInventory, maintenance, users },
      counts: { groups: groups.length, hotels: hotels.length, rooms: rooms.length, roomLogs: roomLogs.length, expenses: expenses.length, posTransactions: posTransactions.length, maintenance: maintenance.length, users: users.length },
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="anchor-backup-${Date.now()}.json"`);
    res.json(backup);
  } catch (err) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message });
  }
});

// ── Restore from Backup ───────────────────────────────────────────────────────
router.post('/restore', async (req, res) => {
  try {
    const { backup } = req.body;
    if (!backup?.metadata || !backup?.data) return res.status(400).json({ error: 'Invalid backup file' });

    const results = { restored: {}, errors: [] };

    for (const g of (backup.data.groups || [])) {
      await prisma.hotelGroup.upsert({ where: { id: g.id }, update: { name: g.name }, create: g }).catch(e => results.errors.push(e.message));
    }
    results.restored.groups = backup.data.groups?.length || 0;

    for (const h of (backup.data.hotels || [])) {
      const { id, ...data } = h;
      await prisma.hotel.upsert({ where: { id }, update: data, create: h }).catch(e => results.errors.push(e.message));
    }
    results.restored.hotels = backup.data.hotels?.length || 0;

    for (const r of (backup.data.rooms || [])) {
      const { id, ...data } = r;
      await prisma.room.upsert({ where: { id }, update: data, create: r }).catch(() => {});
    }
    results.restored.rooms = backup.data.rooms?.length || 0;

    res.json({ success: true, results, errorCount: results.errors.length });
  } catch (err) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message });
  }
});

// ── CSV/Excel Room Import ─────────────────────────────────────────────────────
router.post('/import/rooms', async (req, res) => {
  try {
    const { rooms, hotelId } = req.body;
    if (!Array.isArray(rooms) || !hotelId) return res.status(400).json({ error: 'rooms array and hotelId required' });

    const results = { created: 0, errors: [] };
    for (const room of rooms) {
      await prisma.room.upsert({
        where: { hotelId_number: { hotelId, number: String(room.number) } },
        update: { type: room.type?.toUpperCase() || 'STANDARD', floor: parseInt(room.floor) || 1, pricePerNight: parseFloat(room.pricePerNight) || 0, maxOccupants: parseInt(room.maxOccupants) || 2 },
        create: { hotelId, number: String(room.number), type: room.type?.toUpperCase() || 'STANDARD', floor: parseInt(room.floor) || 1, pricePerNight: parseFloat(room.pricePerNight) || 0, maxOccupants: parseInt(room.maxOccupants) || 2 },
      }).then(() => results.created++).catch(e => results.errors.push(`Room ${room.number}: ${e.message}`));
    }

    const roomCount = await prisma.room.count({ where: { hotelId } });
    await prisma.hotel.update({ where: { id: hotelId }, data: { totalRooms: roomCount } });

    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message });
  }
});

export default router;
