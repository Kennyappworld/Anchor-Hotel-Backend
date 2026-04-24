import express from 'express';
import prisma from '../lib/prisma.js';
import { authenticate, requireLevel, requireHotelAccess } from '../middleware/auth.js';

const router = express.Router();

// GET rooms by hotel
router.get('/hotel/:hotelId', authenticate, requireHotelAccess(), async (req, res) => {
  try {
    const rooms = await prisma.room.findMany({
      where: { hotelId: req.params.hotelId },
      include: {
        roomLogs: {
          where: { status: 'ACTIVE' },
          take: 1,
          orderBy: { createdAt: 'desc' },
          include: { createdBy: { select: { name: true } } },
        },
      },
      orderBy: [{ floor: 'asc' }, { number: 'asc' }],
    });
    res.json(rooms);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch rooms' });
  }
});

// GET single room
router.get('/:id', authenticate, async (req, res) => {
  try {
    const room = await prisma.room.findUnique({
      where: { id: req.params.id },
      include: {
        roomLogs: {
          take: 10,
          orderBy: { createdAt: 'desc' },
          include: { createdBy: { select: { name: true } } },
        },
        maintenanceLogs: {
          where: { status: { not: 'RESOLVED' } },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!room) return res.status(404).json({ error: 'Room not found' });
    res.json(room);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch room' });
  }
});

// CREATE room (Level 7+)
router.post('/', authenticate, requireLevel(7), async (req, res) => {
  try {
    const { hotelId, number, type, pricePerNight, floor, description, maxOccupants, amenities } = req.body;
    if (!hotelId || !number || !pricePerNight) {
      return res.status(400).json({ error: 'hotelId, number, and pricePerNight are required' });
    }

    const room = await prisma.room.create({
      data: {
        hotelId,
        number,
        type: type || 'STANDARD',
        pricePerNight: parseFloat(pricePerNight),
        floor: floor ? parseInt(floor) : null,
        description,
        maxOccupants: maxOccupants ? parseInt(maxOccupants) : 2,
        amenities,
      },
    });
    res.status(201).json(room);
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'Room number already exists in this hotel' });
    }
    res.status(500).json({ error: 'Failed to create room' });
  }
});

// UPDATE room (Level 7+ for price, Level 5 for status only)
router.put('/:id', authenticate, requireLevel(5), async (req, res) => {
  try {
    const { status, description, amenities } = req.body;
    const updateData = {};

    // Level 5 (Front Desk) can only update status
    if (req.user.accessLevel >= 7) {
      const { type, pricePerNight, floor, maxOccupants } = req.body;
      if (type) updateData.type = type;
      if (pricePerNight) updateData.pricePerNight = parseFloat(pricePerNight);
      if (floor !== undefined) updateData.floor = floor ? parseInt(floor) : null;
      if (maxOccupants) updateData.maxOccupants = parseInt(maxOccupants);
      if (description !== undefined) updateData.description = description;
      if (amenities !== undefined) updateData.amenities = amenities;
    }

    if (status) updateData.status = status;

    const room = await prisma.room.update({
      where: { id: req.params.id },
      data: updateData,
    });
    res.json(room);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update room' });
  }
});

// DELETE room (Super Admin only)
router.delete('/:id', authenticate, requireLevel(10), async (req, res) => {
  try {
    // Check for active bookings
    const activeLog = await prisma.roomLog.findFirst({
      where: { roomId: req.params.id, status: 'ACTIVE' },
    });
    if (activeLog) {
      return res.status(409).json({ error: 'Cannot delete room with active booking' });
    }
    await prisma.room.delete({ where: { id: req.params.id } });
    res.json({ message: 'Room deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete room' });
  }
});

export default router;
