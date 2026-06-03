/**
 * rooms.js  v6
 * Added: DELETE room with active-guest safety check
 *        Manager (level 7) can delete vacant rooms
 */
import express from 'express';
import { z } from 'zod';

const roomSchema = z.object({
  number: z.string().min(1, 'Room number required').max(20),
  type: z.enum(['STANDARD', 'DELUXE', 'SUITE', 'PENTHOUSE']),
  pricePerNight: z.number().positive('Price must be positive'),
  floor: z.number().int().optional(),
  description: z.string().max(500).optional(),
  customName: z.string().max(100).optional(),
  amenities: z.string().max(500).optional(),
  maxOccupants: z.number().int().min(1).max(20).optional(),
});

function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten().fieldErrors });
    }
    req.body = result.data;
    next();
  };
}
import prisma from './prisma.js';
import { authenticate, requireLevel, requireHotelAccess } from './middleware.js';

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
        maintenanceLogs: {
          where: { status: { not: 'RESOLVED' } },
          take: 1,
          orderBy: { createdAt: 'desc' },
          select: { status: true, title: true },
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

// CREATE room (Level 5+)
router.post('/', authenticate, requireLevel(5), async (req, res) => {
  try {
    const { hotelId, number, type, pricePerNight, floor, description, customName, maxOccupants, amenities } = req.body;
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
        customName,
        maxOccupants: maxOccupants ? parseInt(maxOccupants) : 2,
        amenities,
      },
    });
    res.status(201).json(room);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Room number already exists in this hotel' });
    res.status(500).json({ error: 'Failed to create room' });
  }
});

// UPDATE room (Level 5+)
router.put('/:id', authenticate, requireLevel(5), async (req, res) => {
  try {
    const { number, type, pricePerNight, floor, status, description, customName, maxOccupants, amenities } = req.body;
    const data = {};
    if (number !== undefined) data.number = number;
    if (type !== undefined) data.type = type;
    if (pricePerNight !== undefined) data.pricePerNight = parseFloat(pricePerNight);
    if (floor !== undefined) data.floor = floor ? parseInt(floor) : null;
    if (status !== undefined) data.status = status;
    if (description !== undefined) data.description = description;
    if (customName !== undefined) data.customName = customName;
    if (maxOccupants !== undefined) data.maxOccupants = parseInt(maxOccupants);
    if (amenities !== undefined) data.amenities = amenities;

    const room = await prisma.room.update({ where: { id: req.params.id }, data });
    res.json(room);
  } catch (err) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message });
  }
});

// DELETE room (Level 7+ — GENERAL_MANAGER and above)
// Safety: cannot delete a room with an ACTIVE guest checked in
router.delete('/:id', authenticate, requireLevel(7), async (req, res) => {
  try {
    const room = await prisma.room.findUnique({
      where: { id: req.params.id },
      include: {
        roomLogs: { where: { status: 'ACTIVE' }, take: 1 },
      },
    });
    if (!room) return res.status(404).json({ error: 'Room not found' });

    if (room.roomLogs.length > 0) {
      return res.status(409).json({
        error: `Room ${room.number} has an active guest checked in. Check them out before deleting.`,
      });
    }

    // Safe to delete
    await prisma.room.delete({ where: { id: req.params.id } });
    res.json({ success: true, message: `Room ${room.number} deleted successfully` });
  } catch (err) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message });
  }
});

export default router;
