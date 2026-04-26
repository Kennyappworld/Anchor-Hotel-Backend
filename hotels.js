/**
 * hotels.js
 * Hotel (subsidiary) management routes.
 *
 * Changes from v2:
 *  - Hotels are now associated with a HotelGroup
 *  - GROUP_MANAGER can manage all hotels within their group
 *  - GENERAL_MANAGER and GROUP_MANAGER can update maxStaff (via users route) and totalRooms
 *  - Data isolation enforced via requireHotelAccess middleware
 */

import express from 'express';
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
        group: { select: { name: true, subscriptionExpiry: true, isActive: true } },
        _count: { select: { rooms: true, users: true, roomLogs: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(hotels);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch hotels' });
  }
});

// ── GET single hotel ───────────────────────────────────────────────────────────
router.get('/:id', authenticate, requireHotelAccess('id'), async (req, res) => {
  try {
    const hotel = await prisma.hotel.findUnique({
      where: { id: req.params.id },
      include: {
        group: { select: { name: true, subscriptionExpiry: true, supportPhone: true } },
        rooms: { orderBy: [{ floor: 'asc' }, { number: 'asc' }] },
        _count: { select: { rooms: true, users: true } },
      },
    });
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' });

    // Hide support phone from roles below GENERAL_MANAGER
    if (!['GENERAL_MANAGER', 'GROUP_MANAGER', 'SUPER_ADMIN'].includes(req.user.role)) {
      if (hotel.group) delete hotel.group.supportPhone;
    }

    res.json(hotel);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch hotel' });
  }
});

// ── CREATE hotel (Super Admin / Group Manager) ─────────────────────────────────
router.post('/', authenticate, requireLevel(8), async (req, res) => {
  try {
    const { name, address, phone, email, totalRooms, currency, timezone, groupId, vatPercent } = req.body;
    if (!name || !totalRooms) {
      return res.status(400).json({ error: 'Name and total rooms are required' });
    }

    let targetGroupId = null;
    if (req.user.role === 'SUPER_ADMIN') {
      targetGroupId = groupId || null;
    } else if (req.user.role === 'GROUP_MANAGER') {
      // Group manager can only create hotels under their own group
      targetGroupId = req.user.groupId;
    }

    const hotel = await prisma.hotel.create({
      data: {
        name,
        address,
        phone,
        email,
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
    const { name, address, phone, email, currency, timezone, totalRooms, maxStaff, vatPercent } = req.body;

    const data = {};
    if (name !== undefined) data.name = name;
    if (address !== undefined) data.address = address;
    if (phone !== undefined) data.phone = phone;
    if (email !== undefined) data.email = email;
    if (currency !== undefined) data.currency = currency;
    if (timezone !== undefined) data.timezone = timezone;

    // totalRooms: unlocked for GENERAL_MANAGER and above (was Super Admin only in v2)
    if (totalRooms !== undefined && req.user.accessLevel >= 7) {
      data.totalRooms = parseInt(totalRooms);
    }

    // maxStaff: editable by GENERAL_MANAGER and above
    if (maxStaff !== undefined && req.user.accessLevel >= 7) {
      data.maxStaff = parseInt(maxStaff);
    }

    // vatPercent: editable by GENERAL_MANAGER and above; must be 0–100
    if (vatPercent !== undefined && req.user.accessLevel >= 7) {
      const vat = parseFloat(vatPercent);
      if (isNaN(vat) || vat < 0 || vat > 100) {
        return res.status(400).json({ error: 'vatPercent must be a number between 0 and 100' });
      }
      data.vatPercent = vat;
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

// ── DELETE hotel (Super Admin only) ───────────────────────────────────────────
router.delete('/:id', authenticate, requireLevel(10), async (req, res) => {
  try {
    await prisma.hotel.delete({ where: { id: req.params.id } });
    res.json({ message: 'Hotel deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete hotel' });
  }
});

export default router;
