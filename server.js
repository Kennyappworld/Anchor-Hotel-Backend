import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';

// Routes
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
const PORT = process.env.PORT || 3001;

// Trust Railway's reverse proxy
app.set('trust proxy', 1);

app.use(helmet({ crossOriginEmbedderPolicy: false, contentSecurityPolicy: false }));

const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5173',
  'http://localhost:3000',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.some((o) => origin.startsWith(o))) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Anchor Hotel Suite API', environment: process.env.NODE_ENV });
});

app.use('/api/auth', authRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/hotels', hotelRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/room-logs', roomLogRoutes);
app.use('/api/maintenance', maintenanceRoutes);
app.use('/api/pos', posRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/users', userRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/receipts', receiptRoutes);

app.use('*', (req, res) => res.status(404).json({ error: 'Route not found' }));

app.use((err, req, res, next) => {
  if (err.message === 'Not allowed by CORS') return res.status(403).json({ error: 'CORS policy violation' });
  if (err.name === 'JsonWebTokenError') return res.status(401).json({ error: 'Invalid token' });
  if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired' });
  res.status(err.status || 500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message });
});

app.listen(PORT, () => {
  console.log(`\n🏨 Anchor Hotel Suite API`);
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV}`);
  console.log(`🔒 WebAuthn RP: ${process.env.WEBAUTHN_RP_ID}\n`);
});

export default app;
