/**
 * performance.js — Staff performance analytics and guest feedback
 * 
 * GET  /api/performance/staff           — Staff leaderboard by response time
 * GET  /api/performance/feedback        — Guest feedback summary
 * GET  /api/performance/trends          — Week-over-week response time trends
 * POST /api/guest/:qrToken/feedback     — Submit guest feedback (via QR portal, public)
 * POST /api/guest/:qrToken/rate/:requestId — Rate a specific service request
 */

import express from 'express';
import rateLimit from 'express-rate-limit';
import prisma from './prisma.js';
import { authenticate, requireLevel } from './middleware.js';

const router = express.Router();

// ── GET /api/performance/staff — Staff leaderboard ────────────────────────────
// Returns staff ranked by average response time (this week vs last week)
router.get('/staff', authenticate, requireLevel(5), async (req, res) => {
  try {
    const { hotelId, period = 'week' } = req.query;
    const targetHotelId = hotelId || req.user.hotelId;

    const now = new Date();
    const periodMs = period === 'month' ? 30 * 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    const thisStart  = new Date(now.getTime() - periodMs);
    const lastStart  = new Date(now.getTime() - 2 * periodMs);
    const lastEnd    = thisStart;

    // Get all completed requests with assignee for this and last period
    const [thisPeriod, lastPeriod, allStaff] = await Promise.all([
      prisma.guestServiceRequest.findMany({
        where: {
          hotelId: targetHotelId,
          status: 'COMPLETED',
          completedAt: { gte: thisStart },
          assignedToId: { not: null },
          responseMinutes: { not: null },
        },
        select: { assignedToId: true, responseMinutes: true, type: true, createdAt: true },
      }),
      prisma.guestServiceRequest.findMany({
        where: {
          hotelId: targetHotelId,
          status: 'COMPLETED',
          completedAt: { gte: lastStart, lt: lastEnd },
          assignedToId: { not: null },
          responseMinutes: { not: null },
        },
        select: { assignedToId: true, responseMinutes: true },
      }),
      prisma.user.findMany({
        where: { hotelId: targetHotelId, isVerified: true, isSuspended: false },
        select: { id: true, name: true, role: true, accessLevel: true },
      }),
    ]);

    // Build staff map
    const staffMap = Object.fromEntries(allStaff.map(s => [s.id, s]));

    // Aggregate this period
    const thisAgg = {};
    thisPeriod.forEach(r => {
      if (!thisAgg[r.assignedToId]) thisAgg[r.assignedToId] = { total: 0, count: 0, byType: {} };
      thisAgg[r.assignedToId].total += r.responseMinutes;
      thisAgg[r.assignedToId].count++;
      thisAgg[r.assignedToId].byType[r.type] = (thisAgg[r.assignedToId].byType[r.type] || 0) + 1;
    });

    // Aggregate last period
    const lastAgg = {};
    lastPeriod.forEach(r => {
      if (!lastAgg[r.assignedToId]) lastAgg[r.assignedToId] = { total: 0, count: 0 };
      lastAgg[r.assignedToId].total += r.responseMinutes;
      lastAgg[r.assignedToId].count++;
    });

    // Build leaderboard — only include staff who have handled at least one request
    const leaderboard = Object.entries(thisAgg)
      .map(([staffId, data]) => {
        const staff = staffMap[staffId];
        if (!staff) return null;

        const avgThis = Math.round(data.total / data.count);
        const lastData = lastAgg[staffId];
        const avgLast = lastData ? Math.round(lastData.total / lastData.count) : null;

        // Trend: positive = improved (faster), negative = worsened (slower)
        const trend = avgLast !== null ? avgLast - avgThis : null;
        const trendPct = avgLast ? Math.round(((avgLast - avgThis) / avgLast) * 100) : null;

        // Performance grade
        let grade = 'A';
        if (avgThis > 60) grade = 'D';
        else if (avgThis > 30) grade = 'C';
        else if (avgThis > 15) grade = 'B';

        return {
          staffId,
          name:         staff.name,
          role:         staff.role,
          avgResponseMinutes: avgThis,
          requestsCompleted:  data.count,
          grade,
          trend,       // positive = got faster (good)
          trendPct,
          trendDir:    trend === null ? 'new' : trend > 0 ? 'improved' : trend < 0 ? 'worsened' : 'same',
          topRequestType: Object.entries(data.byType).sort((a, b) => b[1] - a[1])[0]?.[0] || 'GENERAL',
          lastPeriodAvg: avgLast,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.avgResponseMinutes - b.avgResponseMinutes); // fastest first

    // Hotel averages
    const allMinutes = thisPeriod.map(r => r.responseMinutes);
    const hotelAvg = allMinutes.length
      ? Math.round(allMinutes.reduce((s, m) => s + m, 0) / allMinutes.length)
      : null;

    res.json({
      leaderboard,
      hotelAvgResponseMinutes: hotelAvg,
      totalRequestsCompleted: thisPeriod.length,
      period,
    });
  } catch (err) {
    console.error('Performance error:', err.message);
    res.status(500).json({ error: 'Failed to load performance data' });
  }
});

// ── GET /api/performance/trends — Week by week for last 8 weeks ───────────────
router.get('/trends', authenticate, requireLevel(7), async (req, res) => {
  try {
    const { hotelId } = req.query;
    const targetHotelId = hotelId || req.user.hotelId;

    const weeks = [];
    for (let i = 7; i >= 0; i--) {
      const end   = new Date(Date.now() - i * 7 * 24 * 60 * 60 * 1000);
      const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);

      const requests = await prisma.guestServiceRequest.findMany({
        where: {
          hotelId: targetHotelId,
          status: 'COMPLETED',
          completedAt: { gte: start, lt: end },
          responseMinutes: { not: null },
        },
        select: { responseMinutes: true },
      });

      const avg = requests.length
        ? Math.round(requests.reduce((s, r) => s + r.responseMinutes, 0) / requests.length)
        : null;

      weeks.push({
        weekStart: start.toISOString(),
        weekLabel: start.toLocaleDateString('en-NG', { day: 'numeric', month: 'short' }),
        avgMinutes: avg,
        requestCount: requests.length,
      });
    }

    res.json({ weeks });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load trends' });
  }
});

// ── GET /api/performance/feedback — Guest feedback summary ────────────────────
router.get('/feedback', authenticate, requireLevel(5), async (req, res) => {
  try {
    const { hotelId } = req.query;
    const targetHotelId = hotelId || req.user.hotelId;
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const feedback = await prisma.guestFeedback.findMany({
      where: { hotelId: targetHotelId, createdAt: { gte: since } },
      include: { roomLog: { select: { guestName: true, room: { select: { number: true } } } } },
      orderBy: { createdAt: 'desc' },
    });

    const withRatings = feedback.filter(f => f.overallRating !== null);
    const avgRating = withRatings.length
      ? (withRatings.reduce((s, f) => s + f.overallRating, 0) / withRatings.length).toFixed(1)
      : null;

    const dist = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    withRatings.forEach(f => { dist[f.overallRating]++ });

    res.json({
      avgRating: avgRating ? parseFloat(avgRating) : null,
      totalReviews: withRatings.length,
      distribution: dist,
      recent: feedback.slice(0, 20).map(f => ({
        id:            f.id,
        guestName:     f.roomLog?.guestName || 'Guest',
        roomNumber:    f.roomLog?.room?.number || '—',
        overallRating: f.overallRating,
        comment:       f.overallComment,
        serviceRating: f.serviceRating,
        serviceComment: f.serviceComment,
        date:          f.createdAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load feedback' });
  }
});

// ── PUBLIC: POST /api/guest/:qrToken/feedback — Overall stay feedback ─────────
const feedbackLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5 });

router.post('/guest-feedback/:qrToken', feedbackLimiter, async (req, res) => {
  try {
    const { overallRating, overallComment } = req.body;

    if (overallRating && (overallRating < 1 || overallRating > 5)) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }

    const log = await prisma.roomLog.findUnique({
      where: { qrToken: req.params.qrToken },
    });

    if (!log) return res.status(404).json({ error: 'Invalid QR code' });

    // Check if feedback already submitted for this stay
    const existing = await prisma.guestFeedback.findFirst({
      where: { roomLogId: log.id, overallRating: { not: null } },
    });

    if (existing) {
      return res.json({ message: 'Thank you — your feedback has already been recorded.' });
    }

    await prisma.guestFeedback.create({
      data: {
        roomLogId:      log.id,
        hotelId:        log.hotelId,
        overallRating:  overallRating ? parseInt(overallRating) : null,
        overallComment: overallComment?.trim() || null,
      },
    });

    res.json({ message: 'Thank you for your feedback! We hope to see you again.' });
  } catch (err) {
    console.error('Feedback error:', err.message);
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

// ── PUBLIC: POST /api/guest-rate/:requestId — Rate a service request ──────────
router.post('/guest-rate/:requestId', feedbackLimiter, async (req, res) => {
  try {
    const { rating, comment, qrToken } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be 1–5' });
    }

    // Verify ownership via qrToken
    const request = await prisma.guestServiceRequest.findUnique({
      where: { id: req.params.requestId },
      include: { roomLog: true },
    });

    if (!request || request.roomLog?.qrToken !== qrToken) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (request.status !== 'COMPLETED') {
      return res.status(400).json({ error: 'Can only rate completed requests' });
    }

    if (request.guestRating) {
      return res.json({ message: 'Already rated.' });
    }

    await prisma.guestServiceRequest.update({
      where: { id: req.params.requestId },
      data: {
        guestRating: parseInt(rating),
        guestComment: comment?.trim() || null,
      },
    });

    res.json({ message: 'Thank you for your rating!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to submit rating' });
  }
});

export default router;
