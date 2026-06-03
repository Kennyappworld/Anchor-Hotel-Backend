/**
 * groups.js
 * Hotel Group (Parent Tenant) routes.
 *
 * Hierarchy:
 *   SUPER_ADMIN      → full CRUD on all groups
 *   GROUP_MANAGER    → read own group, update settings (warningDays, supportPhone)
 *   others           → no access
 */

import express from 'express';
import prisma from './prisma.js';
import {
  authenticate,
  requireLevel,
  requireGroupAccess,
} from './middleware.js';

const router = express.Router();

// ── GET all groups (Super Admin only) ────────────────────────────────────────
router.get('/', authenticate, requireLevel(10), async (req, res) => {
  try {
    const groups = await prisma.hotelGroup.findMany({
      include: {
        _count: { select: { hotels: true, users: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    try {
      res.json(groups.map(enrichWithCountdown));
    } catch(e) {
      res.json(groups);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

// ── GET own group (Group Manager) ────────────────────────────────────────────
router.get('/me', authenticate, requireLevel(8), async (req, res) => {
  try {
    if (req.user.role === 'SUPER_ADMIN') {
      return res.status(400).json({ error: 'Super Admin has no group. Use /groups instead.' });
    }
    const group = await prisma.hotelGroup.findUnique({
      where: { id: req.user.groupId },
      include: {
        hotels: {
          select: { id: true, name: true, isActive: true, _count: { select: { users: true } } },
        },
        _count: { select: { hotels: true, users: true } },
      },
    });
    if (!group) return res.status(404).json({ error: 'Group not found' });

    // Hide supportPhone for non-GM roles (only GENERAL_MANAGER and above in group see it)
    const data = enrichWithCountdown(group);
    if (req.user.role !== 'GENERAL_MANAGER' && req.user.role !== 'GROUP_MANAGER') {
      delete data.supportPhone;
    }
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch group' });
  }
});

// ── GET analytics across all hotels in all groups (Super Admin) ───────────────
// MUST be defined before /:groupId — otherwise Express matches "analytics" as a groupId param
router.get('/analytics/summary', authenticate, requireLevel(10), async (req, res) => {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [hotels, roomLogAgg, posAgg, expenseAgg, occupiedCount] = await Promise.all([
      prisma.hotel.findMany({
        include: {
          group: { select: { id: true, name: true } },
          _count: { select: { rooms: true, users: true } },
        },
        orderBy: { name: 'asc' },
      }),
      prisma.roomLog.groupBy({
        by: ['hotelId'],
        where: { createdAt: { gte: since } },
        _sum: { totalAmount: true },
      }),
      prisma.pOSSale.groupBy({
        by: ['hotelId'],
        where: { createdAt: { gte: since } },
        _sum: { totalAmount: true },
      }),
      prisma.expense.groupBy({
        by: ['hotelId'],
        where: { createdAt: { gte: since } },
        _sum: { amount: true },
      }),
      prisma.room.groupBy({
        by: ['hotelId'],
        where: { status: 'OCCUPIED' },
        _count: { id: true },
      }),
    ]);

    const roomRev = Object.fromEntries(roomLogAgg.map(r => [r.hotelId, Number(r._sum.totalAmount || 0)]));
    const posRev  = Object.fromEntries(posAgg.map(r => [r.hotelId, Number(r._sum.totalAmount || 0)]));
    const expAmt  = Object.fromEntries(expenseAgg.map(r => [r.hotelId, Number(r._sum.amount || 0)]));
    const occRms  = Object.fromEntries(occupiedCount.map(r => [r.hotelId, r._count.id]));

    const hotelStats = hotels.map(h => {
      const rr = roomRev[h.id] || 0;
      const pr = posRev[h.id] || 0;
      const ex = expAmt[h.id] || 0;
      const oc = occRms[h.id] || 0;
      return {
        hotelId: h.id, hotelName: h.name,
        groupId: h.group?.id || null, groupName: h.group?.name || 'Ungrouped',
        totalRooms: h._count.rooms, staffCount: h._count.users,
        roomRevenue: rr, posRevenue: pr, expenses: ex,
        occupiedRooms: oc,
        netRevenue: rr + pr - ex,
        occupancyRate: h._count.rooms > 0 ? Math.round((oc / h._count.rooms) * 100) : 0,
      };
    });

    const byGroup = {};
    hotelStats.forEach(h => {
      const gk = h.groupId || 'ungrouped';
      if (!byGroup[gk]) byGroup[gk] = {
        groupId: h.groupId, groupName: h.groupName,
        hotels: [], totalRevenue: 0, totalExpenses: 0,
      };
      byGroup[gk].hotels.push(h);
      byGroup[gk].totalRevenue += h.roomRevenue + h.posRevenue;
      byGroup[gk].totalExpenses += h.expenses;
    });

    res.json({ hotels: hotelStats, groups: Object.values(byGroup) });
  } catch (err) {
    console.error('Analytics error:', err);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message });
  }
});

// ── GET single group ──────────────────────────────────────────────────────────
// ── GET subscription status for a group (countdown data) ─────────────────────
router.get('/:groupId/subscription', authenticate, requireLevel(7), requireGroupAccess('groupId'), async (req, res) => {
  try {
    const group = await prisma.hotelGroup.findUnique({
      where: { id: req.params.groupId },
      select: { id: true, name: true, subscriptionExpiry: true, warningDays: true, supportPhone: true },
    });
    if (!group) return res.status(404).json({ error: 'Group not found' });

router.get('/:groupId', authenticate, requireLevel(8), requireGroupAccess('groupId'), async (req, res) => {
  try {
    const group = await prisma.hotelGroup.findUnique({
      where: { id: req.params.groupId },
      include: {
        hotels: true,
        _count: { select: { hotels: true, users: true } },
      },
    });
    if (!group) return res.status(404).json({ error: 'Group not found' });
    res.json(enrichWithCountdown(group));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch group' });
  }
});

// ── CREATE group (Super Admin only) ──────────────────────────────────────────
router.post('/', authenticate, requireLevel(10), async (req, res) => {
  try {
    const { name, logoUrl, subscriptionExpiry, warningDays, supportPhone } = req.body;
    if (!name) return res.status(400).json({ error: 'Group name is required' });

    const group = await prisma.hotelGroup.create({
      data: {
        name,
        logoUrl: logoUrl || null,
        subscriptionExpiry: subscriptionExpiry ? new Date(subscriptionExpiry) : null,
        warningDays: warningDays ? parseInt(warningDays) : 14,
        supportPhone: supportPhone || null,
      },
    });
    res.status(201).json(enrichWithCountdown(group));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

// ── UPDATE group ──────────────────────────────────────────────────────────────
// SUPER_ADMIN: can update everything including subscriptionExpiry & supportPhone
// GROUP_MANAGER: can only update warningDays
router.put('/:groupId', authenticate, requireLevel(8), requireGroupAccess('groupId'), async (req, res) => {
  try {
    const { name, logoUrl, subscriptionExpiry, warningDays, supportPhone, isActive } = req.body;
    const isSuperAdmin = req.user.role === 'SUPER_ADMIN';

    const data = {};

    // Fields any group-level manager can update
    if (warningDays !== undefined) data.warningDays = parseInt(warningDays);

    // Super Admin only fields
    if (isSuperAdmin) {
      if (name !== undefined) data.name = name;
      if (logoUrl !== undefined) data.logoUrl = logoUrl;
      if (subscriptionExpiry !== undefined) data.subscriptionExpiry = subscriptionExpiry ? new Date(subscriptionExpiry) : null;
      if (supportPhone !== undefined) data.supportPhone = supportPhone;
      if (isActive !== undefined) data.isActive = isActive;
    }

    const group = await prisma.hotelGroup.update({
      where: { id: req.params.groupId },
      data,
    });
    res.json(enrichWithCountdown(group));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update group' });
  }
});

// ── DELETE group (Super Admin only) ──────────────────────────────────────────
router.delete('/:groupId', authenticate, requireLevel(10), async (req, res) => {
  try {
    await prisma.hotelGroup.delete({ where: { id: req.params.groupId } });
    res.json({ message: 'Group deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete group' });
  }
});

    const status = computeSubscriptionStatus(group);
    // Only expose supportPhone to GENERAL_MANAGER and GROUP_MANAGER
    if (!['GENERAL_MANAGER', 'GROUP_MANAGER', 'SUPER_ADMIN'].includes(req.user.role)) {
      delete status.supportPhone;
    }
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch subscription status' });
  }
});

// ── Helper: compute countdown + warning state ─────────────────────────────────
function computeSubscriptionStatus(group) {
  const now = Date.now();
  const expiry = group.subscriptionExpiry ? new Date(group.subscriptionExpiry) : null;
  const warningMs = (group.warningDays || 14) * 24 * 60 * 60 * 1000;

  let daysRemaining = null;
  let hoursRemaining = null;
  let minutesRemaining = null;
  let isExpired = false;
  let isWarning = false;

  if (expiry) {
    const diffMs = expiry.getTime() - now;
    isExpired = diffMs <= 0;
    isWarning = !isExpired && diffMs <= warningMs;

    if (!isExpired) {
      daysRemaining = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      hoursRemaining = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      minutesRemaining = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    }
  }

  return {
    groupId: group.id,
    groupName: group.name,
    subscriptionExpiry: expiry?.toISOString() || null,
    warningDays: group.warningDays,
    isExpired,
    isWarning,
    daysRemaining,
    hoursRemaining,
    minutesRemaining,
    // ISO timestamp of warning trigger point
    warningStartsAt: expiry ? new Date(expiry.getTime() - warningMs).toISOString() : null,
    supportPhone: group.supportPhone || null,
  };
}

function enrichWithCountdown(group) {
  const status = computeSubscriptionStatus(group);
  return { ...group, subscriptionStatus: status };
}

export default router;
