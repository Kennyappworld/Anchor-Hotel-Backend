import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import authRoutes from './auth.js';
import groupRoutes from './groups.js';
import hotelRoutes from './hotels.js';
import roomRoutes from './rooms.js';
import roomLogRoutes from './roomLogs.js';
import maintenanceRoutes from './maintenance.js';
import posRoutes from './pos.js';
import expenseRoutes from './expenses.js';
import reportRoutes from './reports.js';
import userRoutes from './users.js';
import transactionRoutes from './transactions.js';
import receiptRoutes from './receipts.js';
import backupRoutes from './backup.js';
import auditRoutes from './auditRoutes.js';
import guestPortalRoutes from './guestPortal.js';
import subscriptionRoutes from './subscriptions.js';
import performanceRoutes from './performance.js';
import shiftRoutes from './shifts.js';
import notificationRoutes from './notifications.js';
import { requireActiveSubscription } from './middleware.js';
import issuanceRoutes from './issuance.js';
import { scheduleWeeklyReport, scheduleMonthlyReport, triggerReport, scheduleSubscriptionChecks } from './scheduler.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

// ── Trust Railway proxy (CRITICAL - fixes rate-limit ERR_ERL_UNEXPECTED_X_FORWARDED_FOR)
app.set('trust proxy', 1);

// Global request timeout - 30 seconds to prevent hanging requests
app.use((req, res, next) => {
  res.setTimeout(30000, () => {
    res.status(408).json({ error: 'Request timeout' });
  });
  next();
});

// ── Security headers (Helmet)
// CSP is defined explicitly to allow our Railway API origin only
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],  // needed for inline Tailwind CSS
      connectSrc: [
        "'self'",
        process.env.FRONTEND_URL || '',
        'https://anchor-hotel-backend-production.up.railway.app',
      ].filter(Boolean),
      imgSrc: ["'self'", 'data:', 'blob:'],
      fontSrc: ["'self'", 'data:'],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  // Strict-Transport-Security: force HTTPS for 1 year
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  // Prevent MIME sniffing
  noSniff: true,
  // Prevent clickjacking
  frameguard: { action: 'deny' },
  // Don't expose X-Powered-By
  hidePoweredBy: true,
}));

// ── Rate limiting
// Auth endpoints: strict (prevents brute-force)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 20,                      // 20 attempts per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait 15 minutes and try again.' },
  skip: (req) => process.env.NODE_ENV === 'development',
});

// Invite endpoint: prevent spam (5 invites per 10 min per IP)
const inviteLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many invite requests. Please wait before sending more.' },
});

// General API: loose (prevents DDoS)
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,    // 1 minute
  max: 300,                     // 300 req/min per IP — plenty for normal use
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
  skip: (req) => process.env.NODE_ENV === 'development',
});

// ── CORS
const allowedOrigins = [
  'https://kennyappworld.github.io',
  'https://anchor-hotel-suite-v6.surge.sh',
  'https://anchor-hotel-suite.surge.sh',
  process.env.FRONTEND_URL,
  'http://localhost:5173',
  'http://localhost:3000',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const allowed = allowedOrigins.some(o => origin === o || origin.startsWith(o));
    if (allowed) return callback(null, true);
    console.log('CORS blocked:', origin);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '10mb' }));
app.use(cookieParser()); // Required for httpOnly JWT cookie

// ── Compression (reduces response size by ~70% — critical for low-bandwidth Nigeria)
app.use(compression({ level: 6, threshold: 1024 }));

// ── Cache headers for static/list endpoints (improves repeat loads)
app.use((req, res, next) => {
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'private, max-age=30, stale-while-revalidate=60');
  } else {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});
app.use(express.urlencoded({ extended: true }));

// ── Apply general rate limit to all API routes
app.use('/api/', apiLimiter);

// ── Health check (no sensitive config in production)
app.get('/health', (req, res) => res.json({
  status: 'ok',
  service: 'Anchor Hotel Suite API',
  timestamp: new Date().toISOString(),
  environment: process.env.NODE_ENV,
  // Only expose connection info in dev
  ...(process.env.NODE_ENV !== 'production' && {
    frontend: process.env.NODE_ENV === 'production' ? '[hidden]' : process.env.FRONTEND_URL,
    webauthnRpId: process.env.WEBAUTHN_RP_ID,
  }),
}));

// ── Routes
app.use('/api/auth',         authLimiter, authRoutes);
app.use('/api/groups',       groupRoutes);
app.use('/api/hotels',       hotelRoutes);
app.use('/api/rooms', requireActiveSubscription,        roomRoutes);
app.use('/api/room-logs', requireActiveSubscription,    roomLogRoutes);
app.use('/api/maintenance', requireActiveSubscription,  maintenanceRoutes);
app.use('/api/pos', requireActiveSubscription,          posRoutes);
app.use('/api/expenses', requireActiveSubscription,     expenseRoutes);
app.use('/api/reports',      reportRoutes);
app.use('/api/users',        userRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/receipts',     receiptRoutes);
app.use('/api/backup',       backupRoutes);
app.use('/api/audit',        auditRoutes);
app.use('/api/guest',        guestPortalRoutes);
app.use('/api/performance',  performanceRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/issuance', issuanceRoutes);
app.use('/api/shifts',       requireActiveSubscription, shiftRoutes);
app.use('/api/notifications', notificationRoutes);

// ── 404
app.use('*', (req, res) => res.status(404).json({ error: 'Route not found' }));

// ── Global error handler — never leaks stack traces in production
app.use((err, req, res, next) => {
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) console.error('Global error:', err);
  if (err.message === 'Not allowed by CORS') return res.status(403).json({ error: 'CORS blocked' });
  if (err.name === 'JsonWebTokenError') return res.status(401).json({ error: 'Invalid token' });
  if (err.name === 'TokenExpiredError')  return res.status(401).json({ error: 'Token expired' });
  // In production, never send raw error messages — they may contain schema/DB details
  const message = isProd ? 'Internal server error' : (err.message || 'Internal server error');
  res.status(err.status || 500).json({ error: message });
});


// ── Test email endpoint (Super Admin only) ────────────────────────────────────
import { authenticate as _auth } from './middleware.js';
app.post('/api/test-email', _auth, async (req, res) => {
  try {
    if (req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Super Admin only' });
    }
    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.default.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT) || 465,
      secure: true,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.verify();
    const { to } = req.body;
    await transporter.sendMail({
      from: `"Anchor Hotel Suite" <${process.env.SMTP_USER}>`,
      to: to || process.env.SMTP_USER,
      subject: '✅ Anchor Hotel Suite - Email Test',
      html: '<h2>Email is working!</h2><p>Your SMTP configuration is correct.</p>',
    });
    res.json({ success: true, message: `Test email sent to ${to || process.env.SMTP_USER}` });
  } catch (err) {
    const isProd = process.env.NODE_ENV === 'production';
    // Only expose SMTP config in non-production — never leak credentials in production
    const config = isProd ? {} : {
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      user: process.env.SMTP_USER,
      passSet: !!process.env.SMTP_PASS,
    };
    res.status(500).json({ error: isProd ? 'Email delivery failed' : err.message, config });
  }
});

// ── Manual report trigger (Super Admin only)
app.post('/api/reports/send', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token' });
    const { authenticate } = await import('./middleware.js');
    // simple inline auth check
    const jwt = await import('jsonwebtoken');
    const token = authHeader.split(' ')[1];
    const decoded = jwt.default.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user || user.role !== 'SUPER_ADMIN') return res.status(403).json({ error: 'Super Admin only' });
    const { type = 'weekly' } = req.body;
    const result = await triggerReport(type);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message });
  }
});

import prisma from './prisma.js';
import { logAction, AUDIT_ACTIONS } from './audit.js';

app.listen(PORT, () => {
  console.log('\n🏨  Anchor Hotel Suite API');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🚀  Port: ${PORT}`);
  console.log(`🌍  Env:  ${process.env.NODE_ENV}`);
  console.log(`🔒  RP:   ${process.env.WEBAUTHN_RP_ID}`);
  console.log(`🌐  CORS: ${process.env.FRONTEND_URL}`);
  console.log(`📧  SMTP: ${process.env.SMTP_HOST ? 'Configured (' + process.env.SMTP_HOST + ')' : 'Not configured'}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  scheduleWeeklyReport();
  scheduleMonthlyReport();
  scheduleSubscriptionChecks();

  // ── Stale WebAuthn challenge cleanup — every 10 minutes
  setInterval(async () => {
    try {
      const { count } = await prisma.webAuthnChallenge.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
      if (count > 0) console.log(`[Security] Purged ${count} expired WebAuthn challenge(s)`);
    } catch (e) {
      console.error('[Security] Challenge cleanup failed:', e.message);
    }
  }, 10 * 60 * 1000);

  // ── NDPA 2023 Data Retention Job — runs daily at 2 AM
  // Anonymises guest PII for records past their 2-year retention window
  const scheduleNDPACleanup = () => {
    const now = new Date();
    const next2AM = new Date(now);
    next2AM.setHours(2, 0, 0, 0);
    if (next2AM <= now) next2AM.setDate(next2AM.getDate() + 1);
    const msUntil2AM = next2AM.getTime() - now.getTime();

    setTimeout(async () => {
      try {
        // Find all room logs past retention window
        const expired = await prisma.roomLog.findMany({
          where: {
            retainUntil: { lt: new Date() },
            guestName: { not: '[Anonymised]' }, // not already processed
          },
          select: { id: true },
          take: 500, // batch in chunks
        });

        if (expired.length > 0) {
          // Anonymise guest PII — keep financial records intact
          await prisma.roomLog.updateMany({
            where: { id: { in: expired.map(r => r.id) } },
            data: {
              guestName:    '[Anonymised]',
              guestEmail:   null,
              guestPhone:   null,
              guestIdType:  null,
              guestIdNumber: null,
            },
          });

          console.log(`[NDPA] Anonymised ${expired.length} guest record(s) past 2-year retention window`);

          // Log the anonymisation action
          logAction({
            userId: 'system', userName: 'System', userRole: 'SYSTEM',
            action: AUDIT_ACTIONS.DATA_ANONYMISED,
            entityType: 'RoomLog',
            description: `NDPA automated anonymisation: ${expired.length} guest records past 2-year retention window`,
            newValue: { count: expired.length, date: new Date().toISOString() },
          });
        }
      } catch (err) {
        console.error('[NDPA] Retention cleanup error:', err.message);
      }
      scheduleNDPACleanup(); // reschedule for next day
    }, msUntil2AM);
  };
  scheduleNDPACleanup();
});

export default app;
