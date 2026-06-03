import jwt from 'jsonwebtoken';
import prisma from './prisma.js';

// ── Role → Access Level mapping ───────────────────────────────────────────────
// SUPER_ADMIN  (10) : platform-wide, all groups
// GROUP_MANAGER (8) : manages all hotels inside ONE group
// GENERAL_MANAGER (7) : manages a single hotel
// STAFF_FRONTDESK (5) : front-desk operations
// STAFF_BAR      (3) : bar / restaurant POS
// MAINTENANCE    (1) : maintenance tasks only

export const ACCESS_LEVELS = {
  SUPER_ADMIN:     10,
  GROUP_MANAGER:    8,
  GENERAL_MANAGER:  7,
  STAFF_FRONTDESK:  5,
  STAFF_BAR:        3,
  MAINTENANCE:      1,
};

// ── authenticate ─────────────────────────────────────────────────────────────
// Accepts token from httpOnly cookie (preferred) OR Authorization header (legacy)
export const authenticate = async (req, res, next) => {
  try {
    // 1. Try httpOnly cookie first (most secure)
    let token = req.cookies?.auth_token;
    // 2. Fall back to Authorization header (backward compat during migration)
    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
      }
    }
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: {
        hotel: true,
        group: true,
        extraRoles: true,
      },
    });

    if (!user) return res.status(401).json({ error: 'User not found' });
    if (!user.isVerified) return res.status(403).json({ error: 'Account not verified' });
    if (user.isSuspended) return res.status(403).json({ error: 'Account suspended. Contact your administrator.' });

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// ── requireLevel ──────────────────────────────────────────────────────────────
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

// ── requireRole ───────────────────────────────────────────────────────────────
export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden: insufficient role' });
  }
  next();
};

// ── requireHotelAccess ────────────────────────────────────────────────────────
// Ensures a user can only touch hotels that belong to their own group / hotel.
// SUPER_ADMIN bypasses everything.
// GROUP_MANAGER can access all hotels within their group.
// GENERAL_MANAGER / staff can only access their own hotel.
export const requireHotelAccess = (paramName = 'hotelId') => async (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (req.user.role === 'SUPER_ADMIN') return next();

  const hotelId = req.params[paramName] || req.body.hotelId || req.query.hotelId;
  if (!hotelId) return next();

  if (req.user.role === 'GROUP_MANAGER') {
    // Verify the hotel belongs to the manager's group
    const hotel = await prisma.hotel.findUnique({ where: { id: hotelId } });
    if (!hotel || hotel.groupId !== req.user.groupId) {
      return res.status(403).json({ error: 'Access denied: hotel not in your group' });
    }
    return next();
  }

  // GENERAL_MANAGER and below: must match their own hotel
  if (req.user.hotelId !== hotelId) {
    return res.status(403).json({ error: 'Access denied to this hotel' });
  }
  next();
};

// ── requireGroupAccess ────────────────────────────────────────────────────────
// Ensures users can only access their own group.
export const requireGroupAccess = (paramName = 'groupId') => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (req.user.role === 'SUPER_ADMIN') return next();

  const groupId = req.params[paramName] || req.body.groupId || req.query.groupId;
  if (groupId && req.user.groupId !== groupId) {
    return res.status(403).json({ error: 'Access denied to this group' });
  }
  next();
};

// ── generateToken ─────────────────────────────────────────────────────────────
export const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '24h',
  });
};

// ── requireActiveSubscription ─────────────────────────────────────────────────
// Blocks API access for groups with expired/suspended subscriptions.
// Super Admin is always exempt. Applied on hotel-level routes.
export const requireActiveSubscription = async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    // Super Admin bypasses subscription check
    if (req.user.accessLevel >= 10) return next();

    const groupId = req.user.groupId;
    if (!groupId) return next(); // no group = no subscription required

    const group = await prisma.hotelGroup.findUnique({
      where: { id: groupId },
      select: { isActive: true, subscriptionExpiry: true, name: true },
    });

    if (!group) return next();

    // Grace period: allow access up to 3 days after expiry
    const now = new Date();
    const gracePeriodEnd = group.subscriptionExpiry
      ? new Date(new Date(group.subscriptionExpiry).getTime() + 3 * 24 * 60 * 60 * 1000)
      : null;

    if (!group.isActive && gracePeriodEnd && now > gracePeriodEnd) {
      return res.status(402).json({
        error: 'Subscription expired',
        message: `Access to ${group.name} has been suspended. Please contact your account manager to renew.`,
        code: 'SUBSCRIPTION_EXPIRED',
      });
    }

    next();
  } catch (err) {
    console.error('[Subscription Check]', err.message);
    next(); // Fail open — don't block on middleware error
  }
};
