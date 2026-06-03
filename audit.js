/**
 * audit.js — Centralised audit logging for NDPA 2023 compliance and accountability
 * 
 * All critical actions are logged: check-in, checkout, expense approval/rejection,
 * password reset, user invite, user suspend, role change, price change.
 * 
 * Logs are stored in the AuditLog table and never deleted (compliance requirement).
 */

import prisma from './prisma.js';

// Action constants — use these everywhere for consistency
export const AUDIT_ACTIONS = {
  // Room operations
  CHECK_IN:              'CHECK_IN',
  CHECKOUT:              'CHECKOUT',
  ROOM_STATUS_CHANGE:    'ROOM_STATUS_CHANGE',
  ROOM_CREATED:          'ROOM_CREATED',
  ROOM_DELETED:          'ROOM_DELETED',

  // Financial
  EXPENSE_SUBMITTED:     'EXPENSE_SUBMITTED',
  EXPENSE_APPROVED:      'EXPENSE_APPROVED',
  EXPENSE_REJECTED:      'EXPENSE_REJECTED',
  PRICE_CHANGED:         'PRICE_CHANGED',
  RESTOCK:               'RESTOCK',

  // User management
  USER_INVITED:          'USER_INVITED',
  USER_SUSPENDED:        'USER_SUSPENDED',
  USER_REACTIVATED:      'USER_REACTIVATED',
  PASSWORD_RESET:        'PASSWORD_RESET',
  PASSWORD_CHANGED:      'PASSWORD_CHANGED',
  ROLE_CHANGED:          'ROLE_CHANGED',
  USER_DELETED:          'USER_DELETED',

  // Auth
  LOGIN_PASSWORD:        'LOGIN_PASSWORD',
  LOGIN_BIOMETRIC:       'LOGIN_BIOMETRIC',
  FORGOT_PASSWORD:       'FORGOT_PASSWORD',

  // NDPA compliance
  DATA_ANONYMISED:       'DATA_ANONYMISED',
  PRIVACY_CONSENT:       'PRIVACY_CONSENT',
};

/**
 * Log an action to the audit trail.
 * Non-blocking — errors are logged but never thrown to avoid breaking the main request.
 */
export async function logAction({
  userId,
  userName,
  userRole,
  hotelId = null,
  action,
  entityType,
  entityId = null,
  description,
  oldValue = null,
  newValue = null,
  ipAddress = null,
}) {
  try {
    await prisma.auditLog.create({
      data: {
        userId,
        userName: userName || 'Unknown',
        userRole: userRole || 'UNKNOWN',
        hotelId: hotelId || null,
        action,
        entityType,
        entityId: entityId || null,
        description,
        oldValue: oldValue ? JSON.parse(JSON.stringify(oldValue)) : undefined,
        newValue: newValue ? JSON.parse(JSON.stringify(newValue)) : undefined,
        ipAddress: ipAddress || null,
      },
    });
  } catch (err) {
    // Non-fatal — audit log failure must never break the main operation
    console.error('[AuditLog] Failed to write audit log:', err.message);
  }
}

/**
 * Helper to extract IP from Express request (handles Railway proxy)
 */
export function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || null;
}
