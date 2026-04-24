import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma.js';

// Role access levels
export const ACCESS_LEVELS = {
  SUPER_ADMIN: 10,
  GENERAL_MANAGER: 7,
  STAFF_FRONTDESK: 5,
  STAFF_BAR: 3,
  MAINTENANCE: 1,
};

export const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: { hotel: true },
    });

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    if (!user.isVerified) {
      return res.status(403).json({ error: 'Account not verified' });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Require minimum access level
export const requireLevel = (minLevel) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (req.user.accessLevel < minLevel) {
    return res.status(403).json({
      error: 'Insufficient permissions',
      required: minLevel,
      current: req.user.accessLevel,
    });
  }
  next();
};

// Require specific roles
export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden: insufficient role' });
  }
  next();
};

// Hotel access guard - ensure user belongs to the requested hotel
export const requireHotelAccess = (paramName = 'hotelId') => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (req.user.role === 'SUPER_ADMIN') return next();

  const hotelId = req.params[paramName] || req.body.hotelId || req.query.hotelId;
  if (hotelId && req.user.hotelId !== hotelId) {
    return res.status(403).json({ error: 'Access denied to this hotel' });
  }
  next();
};

export const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};
