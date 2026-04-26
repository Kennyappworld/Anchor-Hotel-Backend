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
    res.json(groups.map(enrichWithCountdown));
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

// ── GET single group ──────────────────────────────────────────────────────────
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

// ── GET subscription status for a group (countdown data) ─────────────────────
router.get('/:groupId/subscription', authenticate, requireLevel(7), requireGroupAccess('groupId'), async (req, res) => {
  try {
    const group = await prisma.hotelGroup.findUnique({
      where: { id: req.params.groupId },
      select: { id: true, name: true, subscriptionExpiry: true, warningDays: true, supportPhone: true },
    });
    if (!group) return res.status(404).json({ error: 'Group not found' });

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
