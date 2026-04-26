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
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import prisma from './prisma.js';
import { authenticate, requireLevel, ACCESS_LEVELS } from './middleware.js';

const router = express.Router();

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
router.post('/invite', authenticate, requireLevel(7), async (req, res) => {
  try {
    const { email, name, role, hotelId } = req.body;
    if (!email || !name || !role) {
      return res.status(400).json({ error: 'Email, name, and role required' });
    }

    const roleLevel = ACCESS_LEVELS[role];
    if (!roleLevel) return res.status(400).json({ error: 'Invalid role' });

    // Cannot invite someone with equal or higher access (except SUPER_ADMIN)
    if (roleLevel >= req.user.accessLevel && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Cannot invite user with equal or higher access level' });
    }

    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) return res.status(409).json({ error: 'User with this email already exists' });

    // Determine target hotel and group
    let targetHotelId = null;
    let targetGroupId = null;

    if (req.user.role === 'SUPER_ADMIN') {
      targetHotelId = hotelId || null;
      if (targetHotelId) {
        const hotel = await prisma.hotel.findUnique({ where: { id: targetHotelId } });
        targetGroupId = hotel?.groupId || null;
      }
    } else if (req.user.role === 'GROUP_MANAGER') {
      targetGroupId = req.user.groupId;
      if (hotelId) {
        // Verify the hotel is in the manager's group
        const hotel = await prisma.hotel.findUnique({ where: { id: hotelId } });
        if (!hotel || hotel.groupId !== req.user.groupId) {
          return res.status(403).json({ error: 'Hotel does not belong to your group' });
        }
        targetHotelId = hotelId;
      }
    } else {
      // GENERAL_MANAGER: can only invite to their own hotel
      targetHotelId = req.user.hotelId;
      targetGroupId = req.user.groupId;
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

    // Send invite – errors are caught internally and logged; endpoint still succeeds
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

// ── GET single user ────────────────────────────────────────────────────────────
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

export default router;
