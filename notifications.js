/**
 * notifications.js  v20
 * 
 * In-app notification system.
 * Notifications are created by backend events (low stock, overdue checkout, etc.)
 * and read by the frontend via polling (every 60 seconds).
 */

import express from 'express';
import prisma  from './prisma.js';
import { authenticate, requireLevel } from './middleware.js';

const router = express.Router();

// ── GET /api/notifications — Get unread for current user's hotel ──────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const hotelId = req.user.hotelId;
    if (!hotelId) return res.json([]);

    const notifications = await prisma.notification.findMany({
      where: {
        hotelId,
        OR: [{ userId: req.user.id }, { userId: null }],
        isRead: false,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    res.json(notifications);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load notifications' });
  }
});

// ── GET /api/notifications/count — Unread count for badge ────────────────────
router.get('/count', authenticate, async (req, res) => {
  try {
    const hotelId = req.user.hotelId;
    if (!hotelId) return res.json({ count: 0 });

    const count = await prisma.notification.count({
      where: {
        hotelId,
        OR: [{ userId: req.user.id }, { userId: null }],
        isRead: false,
      },
    });
    res.json({ count });
  } catch (err) {
    res.json({ count: 0 });
  }
});

// ── PATCH /api/notifications/:id/read — Mark as read ─────────────────────────
router.patch('/:id/read', authenticate, async (req, res) => {
  try {
    await prisma.notification.update({
      where: { id: req.params.id },
      data: { isRead: true },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark read' });
  }
});

// ── PATCH /api/notifications/read-all — Mark all as read ─────────────────────
router.patch('/read-all', authenticate, async (req, res) => {
  try {
    const hotelId = req.user.hotelId;
    if (!hotelId) return res.json({ ok: true });

    await prisma.notification.updateMany({
      where: {
        hotelId,
        OR: [{ userId: req.user.id }, { userId: null }],
        isRead: false,
      },
      data: { isRead: true },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark all read' });
  }
});

// ── Helper: create notification (used internally by other routes) ─────────────
export async function createNotification({ hotelId, userId, type, title, message, entityId }) {
  try {
    await prisma.notification.create({
      data: { hotelId, userId: userId || null, type, title, message, entityId: entityId || null },
    });
  } catch (e) {
    console.error('[Notification create]', e.message);
  }
}

export default router;
