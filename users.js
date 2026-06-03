/**
 * users.js
 * Staff & role management routes.
 *
 * Changes from v2:
 *  - Invite is now group-scoped; GROUP_MANAGER can invite staff for any hotel in their group
 *  - Multi-role assignment: POST /users/:id/extra-roles, DELETE /users/:id/extra-roles/:role
 *  - Per-role permission toggle: PATCH /users/:id/extra-roles/:role/permissions
 *  - maxStaff field unlocked for GENERAL_MANAGER and above
 *  - SMTP: robust transporter with STARTTLS/SSL support, connection verify, detailed error logging
 */

import express from 'express';
import { z } from 'zod';

// ── Zod validation schemas ─────────────────────────────────────────────────
const inviteSchema = z.object({
  email: z.string().email('Valid email required'),
  role: z.enum(['GROUP_MANAGER','GENERAL_MANAGER','STAFF_FRONTDESK','STAFF_BAR','MAINTENANCE']),
  hotelId: z.string().optional(),
  groupId: z.string().optional(),
  name: z.string().min(2, 'Name must be at least 2 characters').optional(),
});

const createUserSchema = z.object({
  name: z.string().min(2, 'Name required'),
  email: z.string().email('Valid email required'),
  password: z.string().min(10, 'Password must be at least 10 characters'),
  role: z.enum(['SUPER_ADMIN','GROUP_MANAGER','GENERAL_MANAGER','STAFF_FRONTDESK','STAFF_BAR','MAINTENANCE']),
  hotelId: z.string().optional(),
  groupId: z.string().optional(),
});

const updateUserSchema = z.object({
  name: z.string().min(2).optional(),
  role: z.enum(['GROUP_MANAGER','GENERAL_MANAGER','STAFF_FRONTDESK','STAFF_BAR','MAINTENANCE']).optional(),
  hotelId: z.string().nullable().optional(),
  groupId: z.string().nullable().optional(),
}).strict();

function zodValidate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: result.error.flatten().fieldErrors,
      });
    }
    next();
  };
}
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import rateLimit from 'express-rate-limit';
import prisma from './prisma.js';
import { authenticate, requireLevel, ACCESS_LEVELS } from './middleware.js';
import { validatePasswordStrength } from './auth.js';

const router = express.Router();

// Invite spam protection: 10 invites per 10 min per IP
const inviteLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many invite requests. Please wait before sending more.' },
});

// ── GET users ──────────────────────────────────────────────────────────────────
router.get('/', authenticate, requireLevel(7), async (req, res) => {
  try {
    const { hotelId, groupId } = req.query;
    const where = {};

    if (req.user.role === 'SUPER_ADMIN') {
      if (groupId) where.groupId = groupId;
      else if (hotelId) where.hotelId = hotelId;
    } else if (req.user.role === 'GROUP_MANAGER') {
      // Can only see users in their own group
      where.groupId = req.user.groupId;
      if (hotelId) where.hotelId = hotelId;
    } else {
      // GENERAL_MANAGER and below: own hotel only
      where.hotelId = req.user.hotelId;
    }

    const users = await prisma.user.findMany({
      where,
      include: {
        hotel: { select: { name: true } },
        group: { select: { name: true } },
        extraRoles: true,
        authenticators: { select: { id: true, deviceName: true, createdAt: true } },
        _count: { select: { authenticators: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const safe = users.map(({ passwordHash, inviteToken, ...u }) => u);
    res.json(safe);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ── INVITE user ────────────────────────────────────────────────────────────────
// Permission matrix:
//   SUPER_ADMIN     → invite anyone at any level to any hotel/group
//   GROUP_MANAGER   → invite GENERAL_MANAGER and below to any hotel in their group
//   GENERAL_MANAGER → invite STAFF_* and MAINTENANCE to any hotel in their group
router.post('/invite', inviteLimiter, authenticate, requireLevel(7), async (req, res) => {
  try {
    const { email, name, role, hotelId } = req.body;
    if (!email || !name || !role) {
      return res.status(400).json({ error: 'Email, name, and role required' });
    }

    const roleLevel = ACCESS_LEVELS[role];
    if (!roleLevel) return res.status(400).json({ error: 'Invalid role' });

    // Cannot invite someone at equal or higher level
    if (req.user.role !== 'SUPER_ADMIN') {
      if (roleLevel >= req.user.accessLevel) {
        return res.status(403).json({ error: 'Cannot invite user with equal or higher access level' });
      }
      // GENERAL_MANAGER can only invite staff-level roles (levels 1–5)
      if (req.user.role === 'GENERAL_MANAGER' && roleLevel >= 7) {
        return res.status(403).json({ error: 'General Managers can only invite staff-level roles' });
      }
    }

    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) return res.status(409).json({ error: 'User with this email already exists' });

    // Resolve target hotel and group
    let targetHotelId = null;
    let targetGroupId = null;

    if (req.user.role === 'SUPER_ADMIN') {
      targetHotelId = hotelId || null;
      if (targetHotelId) {
        const hotel = await prisma.hotel.findUnique({ where: { id: targetHotelId } });
        if (!hotel) return res.status(404).json({ error: 'Hotel not found' });
        targetGroupId = hotel.groupId || null;
      }
    } else if (req.user.role === 'GROUP_MANAGER') {
      targetGroupId = req.user.groupId;
      if (hotelId) {
        const hotel = await prisma.hotel.findUnique({ where: { id: hotelId } });
        if (!hotel || hotel.groupId !== req.user.groupId) {
          return res.status(403).json({ error: 'Hotel does not belong to your group' });
        }
        targetHotelId = hotelId;
      }
      // GROUP_MANAGER can leave hotelId blank for group-level (e.g. a GENERAL_MANAGER not yet assigned to specific hotel)
    } else {
      // GENERAL_MANAGER: can invite staff to any hotel in their group
      targetGroupId = req.user.groupId;
      if (hotelId) {
        const hotel = await prisma.hotel.findUnique({ where: { id: hotelId } });
        if (!hotel || hotel.groupId !== req.user.groupId) {
          return res.status(403).json({ error: 'Hotel does not belong to your group' });
        }
        targetHotelId = hotelId;
      } else {
        targetHotelId = req.user.hotelId; // default to own hotel
      }
    }

    const inviteToken = uuidv4();
    const inviteExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        name,
        role,
        accessLevel: roleLevel,
        hotelId: targetHotelId,
        groupId: targetGroupId,
        inviteToken,
        inviteExpiry,
        isVerified: false,
      },
      include: {
        hotel: { select: { name: true } },
        group: { select: { name: true } },
      },
    });

    const inviteUrl = `${process.env.FRONTEND_URL}/register?token=${inviteToken}`;

    // Send invite – errors caught internally; endpoint always returns the URL so admin can share manually
    const emailResult = await sendInviteEmail(user.email, user.name, inviteUrl, user.hotel?.name, user.group?.name);

    const { passwordHash, inviteToken: _t, ...safeUser } = user;
    res.status(201).json({
      user: safeUser,
      inviteUrl,
      emailDelivered: emailResult.success,
      emailError: emailResult.error || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to invite user' });
  }
});

// ── CREATE user directly (Super Admin only) ────────────────────────────────────
// Unlike /invite which sends an email token, this creates the user immediately
// with a set password. Super Admin can create any role including Group Managers.
// Body: { name, email, password, role, hotelId?, groupId? }
router.post('/create', authenticate, requireLevel(10), async (req, res) => {
  try {
    const { name, email, password, role, hotelId, groupId } = req.body;

    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: 'name, email, password and role are required' });
    }

    // Validate password strength
    const pwCheck = validatePasswordStrength(password);
    if (!pwCheck.valid) return res.status(400).json({ error: pwCheck.message });

    // Check email not already taken
    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) return res.status(409).json({ error: 'A user with this email already exists' });

    // Validate role
    const validRoles = ['SUPER_ADMIN','GROUP_MANAGER','GENERAL_MANAGER','STAFF_FRONTDESK','STAFF_BAR','MAINTENANCE'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
    }

    const accessLevel = ACCESS_LEVELS[role] || 1;
    const passwordHash = await bcrypt.hash(password, 12);

    // Determine hotel and group
    let resolvedHotelId = hotelId || null;
    let resolvedGroupId = groupId || null;

    if (resolvedHotelId) {
      const hotel = await prisma.hotel.findUnique({ where: { id: resolvedHotelId } });
      if (!hotel) return res.status(404).json({ error: 'Hotel not found' });
      if (!resolvedGroupId) resolvedGroupId = hotel.groupId;
    }

    if (resolvedGroupId && !resolvedHotelId && role === 'GENERAL_MANAGER') {
      return res.status(400).json({ error: 'General Manager requires a specific hotel assignment' });
    }

    const user = await prisma.user.create({
      data: {
        name,
        email: email.toLowerCase(),
        passwordHash,
        role,
        accessLevel,
        isVerified: true,  // Direct creation = immediately verified, no invite needed
        hotelId: resolvedHotelId,
        groupId: resolvedGroupId,
      },
      include: {
        hotel: { select: { id: true, name: true } },
        group: { select: { id: true, name: true } },
      },
    });

    // Send welcome email with credentials
    try {
      const { sendInviteEmail } = await import('./users.js');
    } catch (_) {}

    // Send a welcome email
    if (process.env.SMTP_HOST) {
      const port   = parseInt(process.env.SMTP_PORT || '465');
      const secure = process.env.SMTP_SECURE === 'true' || port === 465;
      try {
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST, port, secure,
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
          connectionTimeout: 10000,
        });
        await transporter.sendMail({
          from: `"Anchor Hotel Suite" <${process.env.SMTP_USER}>`,
          to: email,
          subject: `Welcome to Anchor Hotel Suite — Your account is ready`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
              <div style="background:#1A3A5C;padding:20px 24px;">
                <h2 style="color:#fff;margin:0;">🏨 Anchor Hotel Suite</h2>
                <p style="color:#93C5FD;margin:4px 0 0;">Your account has been created</p>
              </div>
              <div style="padding:20px 24px;">
                <p>Dear ${name},</p>
                <p>Your account has been set up on <strong>Anchor Hotel Suite</strong>.</p>
                <table style="width:100%;border-collapse:collapse;margin:16px 0;">
                  <tr><td style="padding:8px;background:#f8fafc;font-weight:bold;">Login URL</td><td style="padding:8px;"><a href="${process.env.FRONTEND_URL}/login">${process.env.FRONTEND_URL}/login</a></td></tr>
                  <tr><td style="padding:8px;background:#f8fafc;font-weight:bold;">Email</td><td style="padding:8px;">${email}</td></tr>
                  <tr><td style="padding:8px;background:#f8fafc;font-weight:bold;">Password</td><td style="padding:8px;">${password}</td></tr>
                  <tr><td style="padding:8px;background:#f8fafc;font-weight:bold;">Role</td><td style="padding:8px;">${role.replace(/_/g, ' ')}</td></tr>
                  ${user.hotel ? `<tr><td style="padding:8px;background:#f8fafc;font-weight:bold;">Hotel</td><td style="padding:8px;">${user.hotel.name}</td></tr>` : ''}
                </table>
                <p style="color:#DC2626;font-size:0.85rem;">⚠️ Please change your password after your first login.</p>
                <hr style="border:1px solid #e2e8f0;margin:16px 0;">
                <p style="color:#94A3B8;font-size:0.75rem;text-align:center;">Powered by <strong>Anchor Suites Limited</strong></p>
              </div>
            </div>`,
        });
      } catch (emailErr) {
        console.error('[Create User Email]', emailErr.message);
      }
    }

    const { passwordHash: _ph, inviteToken: _it, ...safeUser } = user;
    res.status(201).json({
      user: safeUser,
      message: `User created successfully. ${process.env.SMTP_HOST ? 'Welcome email sent.' : 'No email sent — SMTP not configured.'}`,
    });
  } catch (err) {
    console.error('Create user error:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// ── GET single user ────────────────────────────────────────────────────────────
router.post('/:id/resend-invite', authenticate, requireLevel(7), async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: { hotel: true, group: true },
    });
    if (!user || user.isVerified) {
      return res.status(400).json({ error: 'User not found or already verified' });
    }

    const newToken = uuidv4();
    const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await prisma.user.update({
      where: { id: user.id },
      data: { inviteToken: newToken, inviteExpiry: newExpiry },
    });

    const inviteUrl = `${process.env.FRONTEND_URL}/register?token=${newToken}`;
    const emailResult = await sendInviteEmail(user.email, user.name, inviteUrl, user.hotel?.name, user.group?.name);

    res.json({ message: 'Invite resent', inviteUrl, emailDelivered: emailResult.success });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resend invite' });
  }
});

// ── ASSIGN extra role to staff (Manager only) ─────────────────────────────────
// POST /users/:id/extra-roles  { role, permissions }
router.post('/:id/extra-roles', authenticate, requireLevel(7), async (req, res) => {
  try {
    const { role, permissions = {} } = req.body;
    if (!role) return res.status(400).json({ error: 'Role is required' });

    const targetUser = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    // Scope check
    if (req.user.role !== 'SUPER_ADMIN' && targetUser.hotelId !== req.user.hotelId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Cannot assign role equal to or higher than requesting user's role
    if (ACCESS_LEVELS[role] >= req.user.accessLevel && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Cannot assign a role equal to or higher than your own' });
    }

    const extraRole = await prisma.userExtraRole.upsert({
      where: { userId_role: { userId: req.params.id, role } },
      update: { permissions },
      create: { userId: req.params.id, role, permissions },
    });

    res.status(201).json(extraRole);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to assign extra role' });
  }
});

// ── LIST extra roles for a user ───────────────────────────────────────────────
router.get('/:id/extra-roles', authenticate, requireLevel(7), async (req, res) => {
  try {
    const extraRoles = await prisma.userExtraRole.findMany({
      where: { userId: req.params.id },
    });
    res.json(extraRoles);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch extra roles' });
  }
});

// ── UPDATE permissions for an extra role ─────────────────────────────────────
// PATCH /users/:id/extra-roles/:role  { permissions: { canCheckIn: true, ... } }
router.patch('/:id/extra-roles/:role', authenticate, requireLevel(7), async (req, res) => {
  try {
    const { permissions } = req.body;
    if (!permissions || typeof permissions !== 'object') {
      return res.status(400).json({ error: 'permissions object required' });
    }

    const targetUser = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    if (req.user.role !== 'SUPER_ADMIN' && targetUser.hotelId !== req.user.hotelId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const updated = await prisma.userExtraRole.update({
      where: { userId_role: { userId: req.params.id, role: req.params.role } },
      data: { permissions },
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update role permissions' });
  }
});

// ── REMOVE extra role from user ───────────────────────────────────────────────
router.delete('/:id/extra-roles/:role', authenticate, requireLevel(7), async (req, res) => {
  try {
    const targetUser = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    if (req.user.role !== 'SUPER_ADMIN' && targetUser.hotelId !== req.user.hotelId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await prisma.userExtraRole.delete({
      where: { userId_role: { userId: req.params.id, role: req.params.role } },
    });
    res.json({ message: 'Extra role removed' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove extra role' });
  }
});

// ── UPDATE hotel maxStaff (Manager / Admin only) ──────────────────────────────
router.patch('/hotel/:hotelId/max-staff', authenticate, requireLevel(7), async (req, res) => {
  try {
    const { maxStaff } = req.body;
    if (maxStaff === undefined || isNaN(parseInt(maxStaff))) {
      return res.status(400).json({ error: 'maxStaff must be a number' });
    }

    // Group isolation
    if (req.user.role !== 'SUPER_ADMIN') {
      const hotel = await prisma.hotel.findUnique({ where: { id: req.params.hotelId } });
      if (!hotel) return res.status(404).json({ error: 'Hotel not found' });
      if (req.user.role === 'GROUP_MANAGER' && hotel.groupId !== req.user.groupId) {
        return res.status(403).json({ error: 'Access denied' });
      }
      if (req.user.role === 'GENERAL_MANAGER' && hotel.id !== req.user.hotelId) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const updated = await prisma.hotel.update({
      where: { id: req.params.hotelId },
      data: { maxStaff: parseInt(maxStaff) },
    });
    res.json({ hotelId: updated.id, maxStaff: updated.maxStaff });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update staff count' });
  }
});

// ── Email Helper ──────────────────────────────────────────────────────────────
async function sendInviteEmail(email, name, inviteUrl, hotelName, groupName) {
  if (!process.env.SMTP_HOST) {
    // Graceful no-email fallback: log invite URL for dev environments
    console.log(`[Email – no SMTP configured] Invite URL for ${email}: ${inviteUrl}`);
    return { success: false, error: 'SMTP not configured; invite URL logged to server console.' };
  }

  try {
    // Determine TLS mode from env or port defaults
    const port = parseInt(process.env.SMTP_PORT || '587');
    const secure = process.env.SMTP_SECURE === 'true' || port === 465;

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure,           // true = TLS on connect (port 465), false = STARTTLS upgrade (port 587)
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      // Increase timeouts for slow relay hosts
      connectionTimeout: 10000,
      greetingTimeout:   5000,
      socketTimeout:     15000,
      // Optional: relax TLS verification for self-signed certs in staging environments
      tls: {
        rejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== 'false',
      },
    });

    // Verify SMTP connection before attempting send
    await transporter.verify();

    const displayOrg = hotelName || groupName || 'Anchor Hotel Suite';

    await transporter.sendMail({
      from: `"${process.env.SMTP_FROM_NAME || 'Anchor Hotel Suite'}" <${process.env.SMTP_FROM || 'noreply@anchorhotelsuite.com'}>`,
      to: email,
      subject: `You're invited to join ${displayOrg}`,
      text: `Hi ${name},\n\nYou have been invited to join ${displayOrg} on Anchor Hotel Suite.\n\nAccept your invitation here:\n${inviteUrl}\n\nThis link expires in 7 days.\n\nAnchor Hotel Suite — Secure Property Management`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:auto;background:#f8fafc;padding:24px;border-radius:8px;">
          <div style="background:#1a3a5c;padding:20px 24px;border-radius:6px 6px 0 0;">
            <h1 style="color:#fff;margin:0;font-size:1.4rem;">🏨 Anchor Hotel Suite</h1>
          </div>
          <div style="background:#fff;padding:24px;border-radius:0 0 6px 6px;border:1px solid #e2e8f0;border-top:none;">
            <p>Hi <strong>${name}</strong>,</p>
            <p>You have been invited to join <strong>${displayOrg}</strong> on Anchor Hotel Suite.</p>
            <p>Click the button below to set up your secure biometric login:</p>
            <a href="${inviteUrl}"
               style="display:inline-block;padding:12px 28px;background:#1a3a5c;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;margin:16px 0;">
              Accept Invitation &amp; Register
            </a>
            <p style="color:#64748b;font-size:0.85rem;margin-top:16px;">⏰ This invitation link expires in <strong>7 days</strong>.</p>
            <hr style="border:1px solid #e2e8f0;margin:24px 0;">
            <p style="color:#94a3b8;font-size:0.75rem;margin:0;">
              Anchor Hotel Suite — Secure Property Management<br>
              If you did not request this invitation, please ignore this email.
            </p>
          </div>
        </div>
      `,
    });

    console.log(`[Email] Invite sent to ${email}`);
    return { success: true };
  } catch (err) {
    // Detailed error logging for diagnosing SMTP failures
    console.error(`[Email ERROR] Failed to send invite to ${email}`);
    console.error(`  Code    : ${err.code || 'N/A'}`);
    console.error(`  Command : ${err.command || 'N/A'}`);
    console.error(`  Response: ${err.response || 'N/A'}`);
    console.error(`  Message : ${err.message}`);
    return { success: false, error: err.message };
  }
}

router.post('/:id/reset-password', authenticate, requireLevel(7), async (req, res) => {
  try {
    const { newPassword } = req.body;
    const pwError = validatePasswordStrength(newPassword);
    if (pwError) return res.status(400).json({ error: pwError });

    const target = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: { hotel: { select: { name: true } } },
    });
    if (!target) return res.status(404).json({ error: 'User not found' });

    // Permission checks
    if (req.user.role !== 'SUPER_ADMIN') {
      // Cannot reset Super Admin passwords
      if (target.role === 'SUPER_ADMIN') {
        return res.status(403).json({ error: 'Cannot reset a Super Admin password' });
      }
      if (req.user.role === 'GROUP_MANAGER') {
        // Must be in the same group, and cannot reset another GM/GROUP_MANAGER
        if (target.groupId !== req.user.groupId) {
          return res.status(403).json({ error: 'User is not in your group' });
        }
        if (target.accessLevel >= req.user.accessLevel) {
          return res.status(403).json({ error: 'Cannot reset password for a user with equal or higher access' });
        }
      } else if (req.user.role === 'GENERAL_MANAGER') {
        // Only their own hotel staff
        if (target.hotelId !== req.user.hotelId) {
          return res.status(403).json({ error: 'User is not in your hotel' });
        }
        if (target.accessLevel >= req.user.accessLevel) {
          return res.status(403).json({ error: 'Cannot reset password for a user with equal or higher access' });
        }
      }
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({
      where: { id: req.params.id },
      data: { passwordHash, isVerified: true }, // mark verified if resetting
    });

    res.json({ success: true, message: `Password reset for ${target.name}` });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ── SUSPEND / UNSUSPEND USER ──────────────────────────────────────────────────
// Toggling isSuspended — suspended users cannot log in
// Same permission hierarchy as reset-password
router.patch('/:id/suspend', authenticate, requireLevel(7), async (req, res) => {
  try {
    const { suspend } = req.body; // true = suspend, false = unsuspend

    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) return res.status(404).json({ error: 'User not found' });

    // Cannot suspend yourself
    if (target.id === req.user.id) return res.status(400).json({ error: 'Cannot suspend your own account' });

    // Permission checks
    if (req.user.role !== 'SUPER_ADMIN') {
      if (target.role === 'SUPER_ADMIN') return res.status(403).json({ error: 'Cannot suspend a Super Admin' });
      if (req.user.role === 'GROUP_MANAGER') {
        if (target.groupId !== req.user.groupId) return res.status(403).json({ error: 'User is not in your group' });
        if (target.accessLevel >= req.user.accessLevel) return res.status(403).json({ error: 'Cannot suspend a user with equal or higher access' });
      } else if (req.user.role === 'GENERAL_MANAGER') {
        if (target.hotelId !== req.user.hotelId) return res.status(403).json({ error: 'User is not in your hotel' });
        if (target.accessLevel >= req.user.accessLevel) return res.status(403).json({ error: 'Cannot suspend a user with equal or higher access' });
      }
    }

    const isSuspended = suspend !== undefined ? Boolean(suspend) : !target.isSuspended;

    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: { isSuspended },
    });

    res.json({
      success: true,
      isSuspended: updated.isSuspended,
      message: `${target.name} has been ${isSuspended ? 'suspended' : 'reactivated'}`,
    });
  } catch (err) {
    // isSuspended field might not exist yet — add a graceful fallback
    if (err.message?.includes('Unknown field') || err.code === 'P2009') {
      return res.status(500).json({
        error: 'The isSuspended field is not yet in your database schema. Please run: npx prisma db push --schema=schema.prisma',
      });
    }
    console.error('Suspend error:', err);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message });
  }
});
router.get('/:id', authenticate, requireLevel(7), async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        hotel: { select: { name: true } },
        group: { select: { name: true } },
        extraRoles: true,
        authenticators: { select: { id: true, deviceName: true, createdAt: true } },
      },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Group isolation check
    if (req.user.role !== 'SUPER_ADMIN') {
      if (req.user.role === 'GROUP_MANAGER' && user.groupId !== req.user.groupId) {
        return res.status(403).json({ error: 'Access denied' });
      } else if (req.user.role === 'GENERAL_MANAGER' && user.hotelId !== req.user.hotelId) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const { passwordHash, inviteToken, ...safe } = user;
    res.json(safe);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ── UPDATE user ────────────────────────────────────────────────────────────────
router.put('/:id', authenticate, requireLevel(7), async (req, res) => {
  try {
    const { name, role, hotelId, isVerified } = req.body;
    const updateData = {};

    if (name) updateData.name = name;
    if (role && req.user.role === 'SUPER_ADMIN') {
      updateData.role = role;
      updateData.accessLevel = ACCESS_LEVELS[role];
    }
    if (hotelId !== undefined && req.user.role === 'SUPER_ADMIN') updateData.hotelId = hotelId;
    if (isVerified !== undefined && req.user.role === 'SUPER_ADMIN') updateData.isVerified = isVerified;

    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: updateData,
      include: { hotel: { select: { name: true } } },
    });

    const { passwordHash, inviteToken, ...safe } = updated;
    res.json(safe);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// ── DELETE user (Super Admin only) ────────────────────────────────────────────
router.delete('/:id', authenticate, requireLevel(10), async (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// ── RESEND invite ─────────────────────────────────────────────────────────────
