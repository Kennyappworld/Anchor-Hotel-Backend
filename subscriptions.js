/**
 * subscriptions.js  v16
 * 
 * Subscription & billing management for hotel groups.
 * 
 * Access levels:
 *  - SUPER_ADMIN (10): Full CRUD — create, renew, suspend, cancel, view all
 *  - GROUP_MANAGER (8): View own group subscription status only
 *  - GENERAL_MANAGER (7): View own hotel's group subscription status only
 * 
 * Key design decisions:
 *  - Subscriptions are at GROUP level (one group = one subscription)
 *  - Each hotel within a group is covered by the group subscription
 *  - Super Admin manually records payments (no payment gateway — Nigerian market)
 *  - Auto-expiry job runs daily at midnight Lagos time
 *  - Warning emails sent at 14, 7, 3, 1 days before expiry
 */

import express from 'express';
import prisma from './prisma.js';
import { authenticate, requireLevel } from './middleware.js';
import nodemailer from 'nodemailer';

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: send subscription email
// ─────────────────────────────────────────────────────────────────────────────
async function sendSubscriptionEmail({ to, subject, html }) {
  if (!process.env.SMTP_HOST) return;
  try {
    const port   = parseInt(process.env.SMTP_PORT || '465');
    const secure = process.env.SMTP_SECURE === 'true' || port === 465;
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port, secure,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 10000, socketTimeout: 15000,
    });
    await transporter.sendMail({
      from: `"Anchor Suites Limited" <${process.env.SMTP_USER}>`,
      to, subject, html,
    });
  } catch (e) {
    console.error('[Sub Email]', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/subscriptions  — Super Admin: all subscriptions
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', authenticate, requireLevel(10), async (req, res) => {
  try {
    const subs = await prisma.subscription.findMany({
      include: {
        group: {
          select: {
            id: true, name: true, isActive: true, subscriptionExpiry: true,
            _count: { select: { hotels: true } },
          },
        },
      },
      orderBy: { endDate: 'asc' },
    });

    // Enrich with days-remaining
    const now = new Date();
    const enriched = subs.map(s => ({
      ...s,
      daysRemaining: Math.ceil((new Date(s.endDate) - now) / (1000 * 60 * 60 * 24)),
      isExpired: new Date(s.endDate) < now,
    }));

    res.json(enriched);
  } catch (err) {
    console.error('Subscription list error:', err);
    res.status(500).json({ error: 'Failed to load subscriptions' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/subscriptions/my  — Group Manager / GM: own group's subscription
// ─────────────────────────────────────────────────────────────────────────────
router.get('/my', authenticate, requireLevel(7), async (req, res) => {
  try {
    const groupId = req.user.groupId;
    if (!groupId) return res.status(404).json({ error: 'No group assigned' });

    const group = await prisma.hotelGroup.findUnique({
      where: { id: groupId },
      include: {
        subscriptions: {
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
        _count: { select: { hotels: true } },
      },
    });
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const now = new Date();
    const active = group.subscriptions.find(s => s.status === 'ACTIVE');
    res.json({
      groupName: group.name,
      isActive: group.isActive,
      subscriptionExpiry: group.subscriptionExpiry,
      daysRemaining: group.subscriptionExpiry
        ? Math.ceil((new Date(group.subscriptionExpiry) - now) / (1000 * 60 * 60 * 24))
        : null,
      hotelCount: group._count.hotels,
      currentPlan: active?.plan || null,
      currentAmount: active?.amountNgn || null,
      autoRenew: active?.autoRenew ?? false,
      recentHistory: group.subscriptions.map(s => ({
        id: s.id,
        plan: s.plan,
        amountNgn: s.amountNgn,
        startDate: s.startDate,
        endDate: s.endDate,
        status: s.status,
        daysRemaining: Math.ceil((new Date(s.endDate) - now) / (1000 * 60 * 60 * 24)),
      })),
    });
  } catch (err) {
    console.error('My subscription error:', err);
    res.status(500).json({ error: 'Failed to load subscription' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/subscriptions/group/:groupId  — Super Admin: specific group
// ─────────────────────────────────────────────────────────────────────────────
router.get('/group/:groupId', authenticate, requireLevel(10), async (req, res) => {
  try {
    const group = await prisma.hotelGroup.findUnique({
      where: { id: req.params.groupId },
      include: {
        subscriptions: { orderBy: { createdAt: 'desc' } },
        _count: { select: { hotels: true, users: true } },
      },
    });
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const now = new Date();
    res.json({
      ...group,
      subscriptions: group.subscriptions.map(s => ({
        ...s,
        daysRemaining: Math.ceil((new Date(s.endDate) - now) / (1000 * 60 * 60 * 24)),
        isExpired: new Date(s.endDate) < now,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load group subscription' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/subscriptions  — Super Admin: create/renew subscription
// Body: { groupId, plan, amountNgn, startDate?, durationMonths?, notes?, autoRenew? }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', authenticate, requireLevel(10), async (req, res) => {
  try {
    const {
      groupId, plan = 'MONTHLY', amountNgn,
      startDate, durationMonths, notes, autoRenew = true,
    } = req.body;

    if (!groupId || !amountNgn) {
      return res.status(400).json({ error: 'groupId and amountNgn are required' });
    }

    const group = await prisma.hotelGroup.findUnique({ where: { id: groupId } });
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const start = startDate ? new Date(startDate) : new Date();
    let months = durationMonths;
    if (!months) months = plan === 'YEARLY' ? 12 : 1;

    const end = new Date(start);
    end.setMonth(end.getMonth() + months);

    // Mark any previous ACTIVE subscription for this group as superseded
    await prisma.subscription.updateMany({
      where: { groupId, status: 'ACTIVE' },
      data: { status: 'SUPERSEDED' },
    });

    // Create new subscription
    const sub = await prisma.subscription.create({
      data: {
        groupId,
        plan: plan.toUpperCase(),
        amountNgn: parseFloat(amountNgn),
        status: 'ACTIVE',
        startDate: start,
        endDate: end,
        autoRenew,
        notes: notes || null,
        createdBy: req.user.id,
      },
    });

    // Update group's subscriptionExpiry and isActive
    await prisma.hotelGroup.update({
      where: { id: groupId },
      data: { subscriptionExpiry: end, isActive: true },
    });

    // Send confirmation email to Group Manager
    const gm = await prisma.user.findFirst({
      where: { groupId, role: 'GROUP_MANAGER', isVerified: true },
      select: { email: true, name: true },
    });

    if (gm) {
      await sendSubscriptionEmail({
        to: gm.email,
        subject: `Subscription activated — ${group.name}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
            <div style="background:#1A3A5C;padding:20px 24px;">
              <h2 style="color:#fff;margin:0;">🏨 Anchor Hotel Suite</h2>
              <p style="color:#93C5FD;margin:4px 0 0;font-size:0.85rem;">Subscription Confirmation</p>
            </div>
            <div style="padding:20px 24px;">
              <p>Dear ${gm.name},</p>
              <p>Your subscription for <strong>${group.name}</strong> has been activated.</p>
              <table style="width:100%;border-collapse:collapse;margin:16px 0;">
                <tr><td style="padding:8px;background:#f8fafc;font-weight:bold;">Plan</td><td style="padding:8px;">${plan}</td></tr>
                <tr><td style="padding:8px;background:#f8fafc;font-weight:bold;">Amount</td><td style="padding:8px;">₦${Number(amountNgn).toLocaleString('en-NG')}</td></tr>
                <tr><td style="padding:8px;background:#f8fafc;font-weight:bold;">Start Date</td><td style="padding:8px;">${start.toLocaleDateString('en-NG')}</td></tr>
                <tr><td style="padding:8px;background:#f8fafc;font-weight:bold;">Expiry Date</td><td style="padding:8px;">${end.toLocaleDateString('en-NG')}</td></tr>
                <tr><td style="padding:8px;background:#f8fafc;font-weight:bold;">Auto-Renew</td><td style="padding:8px;">${autoRenew ? 'Yes' : 'No'}</td></tr>
              </table>
              <hr style="border:1px solid #e2e8f0;">
              <p style="color:#94A3B8;font-size:0.75rem;text-align:center;">Powered by <strong>Anchor Suites Limited</strong></p>
            </div>
          </div>`,
      });
    }

    res.json({ subscription: sub, groupUpdated: true, emailSent: !!gm });
  } catch (err) {
    console.error('Create subscription error:', err);
    res.status(500).json({ error: 'Failed to create subscription' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/subscriptions/:id  — Super Admin: update status/notes
// Body: { status?, notes?, autoRenew?, amountNgn? }
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id', authenticate, requireLevel(10), async (req, res) => {
  try {
    const { status, notes, autoRenew, amountNgn } = req.body;
    const data = {};
    if (status)    data.status    = status.toUpperCase();
    if (notes !== undefined) data.notes = notes;
    if (autoRenew !== undefined) data.autoRenew = autoRenew;
    if (amountNgn) data.amountNgn = parseFloat(amountNgn);

    const sub = await prisma.subscription.update({
      where: { id: req.params.id },
      data,
      include: { group: { select: { id: true, name: true } } },
    });

    // If suspended or cancelled, deactivate group
    if (status === 'SUSPENDED' || status === 'CANCELLED') {
      await prisma.hotelGroup.update({
        where: { id: sub.groupId },
        data: { isActive: false },
      });
    }

    res.json(sub);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update subscription' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/subscriptions/summary  — Super Admin: dashboard summary
// ─────────────────────────────────────────────────────────────────────────────
router.get('/summary', authenticate, requireLevel(10), async (req, res) => {
  try {
    const now = new Date();
    const in14Days = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    const [allActive, expiringSoon, expired, totalGroups] = await Promise.all([
      prisma.subscription.count({ where: { status: 'ACTIVE', endDate: { gt: now } } }),
      prisma.subscription.count({ where: { status: 'ACTIVE', endDate: { gt: now, lte: in14Days } } }),
      prisma.subscription.count({ where: { status: 'ACTIVE', endDate: { lte: now } } }),
      prisma.hotelGroup.count(),
    ]);

    // Monthly revenue from active subs
    const activeMonthly = await prisma.subscription.findMany({
      where: { status: 'ACTIVE', endDate: { gt: now } },
      select: { amountNgn: true, plan: true },
    });

    const monthlyRevenue = activeMonthly.reduce((sum, s) => {
      const monthly = s.plan === 'YEARLY'
        ? Number(s.amountNgn) / 12
        : Number(s.amountNgn);
      return sum + monthly;
    }, 0);

    res.json({
      totalGroups,
      activeSubscriptions: allActive,
      expiringSoon,
      expired,
      estimatedMonthlyRevenue: monthlyRevenue,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load summary' });
  }
});

// ── GET /api/subscriptions/billing-targets ────────────────────────────────────
// Returns all groups + standalone hotels (not in any group) for billing
router.get('/billing-targets', authenticate, requireLevel(10), async (req, res) => {
  try {
    const [groups, standaloneHotels] = await Promise.all([
      prisma.hotelGroup.findMany({
        include: {
          _count: { select: { hotels: true } },
          subscriptions: {
            where: { status: 'ACTIVE' },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { endDate: true, plan: true, amountNgn: true, status: true },
          },
        },
        orderBy: { name: 'asc' },
      }),
      prisma.hotel.findMany({
        where: { groupId: null },
        select: { id: true, name: true, address: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    const now = new Date();
    res.json({
      groups: groups.map(g => ({
        id: g.id,
        name: g.name,
        type: 'GROUP',
        hotelCount: g._count.hotels,
        isActive: g.isActive,
        currentPlan: g.subscriptions[0]?.plan || null,
        subscriptionExpiry: g.subscriptions[0]?.endDate || null,
        daysRemaining: g.subscriptions[0]?.endDate
          ? Math.ceil((new Date(g.subscriptions[0].endDate) - now) / (1000*60*60*24))
          : null,
      })),
      standaloneHotels: standaloneHotels.map(h => ({
        id: h.id,
        name: h.name,
        type: 'STANDALONE_HOTEL',
        hotelCount: 1,
        address: h.address,
      })),
    });
  } catch (err) {
    console.error('[Billing targets]', err.message);
    res.status(500).json({ error: 'Failed to load billing targets' });
  }
});

// ── PATCH /api/subscriptions/:id/status ───────────────────────────────────────
router.patch('/:id/status', authenticate, requireLevel(10), async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['ACTIVE','SUSPENDED','CANCELLED'];
    if (!valid.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${valid.join(', ')}` });
    }
    const sub = await prisma.subscription.update({
      where: { id: req.params.id },
      data: { status },
      include: { group: { select: { id: true, name: true } } },
    });
    if (status === 'SUSPENDED' || status === 'CANCELLED') {
      await prisma.hotelGroup.update({
        where: { id: sub.groupId },
        data: { isActive: false },
      });
    }
    res.json(sub);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update subscription status' });
  }
});

export default router;
