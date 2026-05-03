import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
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

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

// ── Trust Railway proxy (CRITICAL - fixes rate-limit ERR_ERL_UNEXPECTED_X_FORWARDED_FOR)
app.set('trust proxy', 1);

// ── Security
app.use(helmet({ crossOriginEmbedderPolicy: false, contentSecurityPolicy: false }));

// ── CORS
const allowedOrigins = [
  'https://kennyappworld.github.io',
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
app.use(express.urlencoded({ extended: true }));

// ── Health check
app.get('/health', (req, res) => res.json({
  status: 'ok',
  service: 'Anchor Hotel Suite API',
  timestamp: new Date().toISOString(),
  environment: process.env.NODE_ENV,
  frontend: process.env.FRONTEND_URL,
  webauthnRpId: process.env.WEBAUTHN_RP_ID,
}));

// ── Routes
app.use('/api/auth',         authRoutes);
app.use('/api/groups',       groupRoutes);
app.use('/api/hotels',       hotelRoutes);
app.use('/api/rooms',        roomRoutes);
app.use('/api/room-logs',    roomLogRoutes);
app.use('/api/maintenance',  maintenanceRoutes);
app.use('/api/pos',          posRoutes);
app.use('/api/expenses',     expenseRoutes);
app.use('/api/reports',      reportRoutes);
app.use('/api/users',        userRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/receipts',     receiptRoutes);

// ── 404
app.use('*', (req, res) => res.status(404).json({ error: 'Route not found' }));

// ── Global error handler
app.use((err, req, res, next) => {
  console.error('Global error:', err.message);
  if (err.message === 'Not allowed by CORS') return res.status(403).json({ error: 'CORS blocked' });
  if (err.name === 'JsonWebTokenError') return res.status(401).json({ error: 'Invalid token' });
  if (err.name === 'TokenExpiredError')  return res.status(401).json({ error: 'Token expired' });
  res.status(err.status || 500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message });
});

app.listen(PORT, () => {
  console.log('\n🏨  Anchor Hotel Suite API');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🚀  Port: ${PORT}`);
  console.log(`🌍  Env:  ${process.env.NODE_ENV}`);
  console.log(`🔒  RP:   ${process.env.WEBAUTHN_RP_ID}`);
  console.log(`🌐  CORS: ${process.env.FRONTEND_URL}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});

export default app;
