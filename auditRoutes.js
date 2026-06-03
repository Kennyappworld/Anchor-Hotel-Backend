/**
 * auditRoutes.js — Audit Log access and NDPA 2023 compliance endpoints
 * 
 * GET  /api/audit           — Read audit logs (GM+ filtered by hotel, Super Admin = all)
 * GET  /api/audit/export    — Export audit logs as CSV (Super Admin only)
 * POST /api/audit/ndpa/anonymise/:roomLogId  — Manually anonymise a guest record on request
 */

import express from 'express';
import prisma from './prisma.js';
import { authenticate, requireLevel } from './middleware.js';
import { logAction, getIP, AUDIT_ACTIONS } from './audit.js';

const router = express.Router();

// ── GET audit logs ─────────────────────────────────────────────────────────────
// Super Admin: all logs across all hotels
// Group Manager (8): all logs for hotels in their group
// General Manager (7): only their hotel's logs
router.get('/', authenticate, requireLevel(7), async (req, res) => {
  try {
    const { page = 1, limit = 50, action, entityType, from, to } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    let hotelFilter;

    if (req.user.role !== 'SUPER_ADMIN') {
      if (req.user.role === 'GROUP_MANAGER') {
        const hotels = await prisma.hotel.findMany({
          where: { groupId: req.user.groupId },
          select: { id: true },
        });
        hotelFilter = hotels.map((h) => h.id);
      } else {
        hotelFilter = req.user.hotelId ? [req.user.hotelId] : [];
      }
    }

    const where = {};
    if (hotelFilter) where.hotelId = { in: hotelFilter };
    if (action) where.action = action;
    if (entityType) where.entityType = entityType;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(String(from));
      if (to) where.createdAt.lte = new Date(String(to));
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: Number(limit),
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({ logs, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    console.error('Audit log fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

// ── NDPA: Manually anonymise a specific guest record ──────────────────────────
// Used when a guest exercises their right to erasure under NDPA 2023
router.post('/ndpa/anonymise/:roomLogId', authenticate, requireLevel(7), async (req, res) => {
  try {
    const log = await prisma.roomLog.findUnique({
      where: { id: req.params.roomLogId },
    });

    if (!log) return res.status(404).json({ error: 'Record not found' });

    // Scope check
    if (req.user.role !== 'SUPER_ADMIN') {
      if (req.user.hotelId !== log.hotelId) {
        const hotel = await prisma.hotel.findUnique({ where: { id: log.hotelId } });
        if (!hotel || hotel.groupId !== req.user.groupId) {
          return res.status(403).json({ error: 'Access denied' });
        }
      }
    }

    if (log.guestName === '[Anonymised]') {
      return res.status(400).json({ error: 'Record already anonymised' });
    }

    const previousGuest = log.guestName;

    await prisma.roomLog.update({
      where: { id: log.id },
      data: {
        guestName:    '[Anonymised]',
        guestEmail:   null,
        guestPhone:   null,
        guestIdType:  null,
        guestIdNumber: null,
        retainUntil:  new Date(), // mark as fully processed
      },
    });

    logAction({
      userId: req.user.id, userName: req.user.name, userRole: req.user.role,
      hotelId: log.hotelId, action: AUDIT_ACTIONS.DATA_ANONYMISED,
      entityType: 'RoomLog', entityId: log.id,
      description: `NDPA right-to-erasure: guest data anonymised on request by ${req.user.name}`,
      oldValue: { guestName: previousGuest },
      newValue: { guestName: '[Anonymised]' },
      ipAddress: getIP(req),
    });

    res.json({
      message: 'Guest personal data anonymised successfully',
      roomLogId: log.id,
      note: 'Financial records (amounts, dates, room number) are retained as required by Nigerian tax law.',
    });
  } catch (err) {
    console.error('NDPA anonymise error:', err);
    res.status(500).json({ error: 'Anonymisation failed' });
  }
});

export default router;
