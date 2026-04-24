import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import prisma from './prisma.js';
import { authenticate, requireLevel, ACCESS_LEVELS } from './middleware.js';

const router = express.Router();

// GET users
router.get('/', authenticate, requireLevel(7), async (req, res) => {
  try {
    const { hotelId } = req.query;
    const where = {};

    if (req.user.role !== 'SUPER_ADMIN') where.hotelId = req.user.hotelId;
    else if (hotelId) where.hotelId = hotelId;

    const users = await prisma.user.findMany({
      where,
      include: {
        hotel: { select: { name: true } },
        authenticators: { select: { id: true, deviceName: true, createdAt: true } },
        _count: { select: { authenticators: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Remove sensitive fields
    const safe = users.map(({ passwordHash, inviteToken, ...u }) => u);
    res.json(safe);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// INVITE user (create with invite token)
router.post('/invite', authenticate, requireLevel(7), async (req, res) => {
  try {
    const { email, name, role, hotelId } = req.body;
    if (!email || !name || !role) {
      return res.status(400).json({ error: 'Email, name, and role required' });
    }

    // Check access level constraints
    const roleLevel = ACCESS_LEVELS[role];
    if (roleLevel >= req.user.accessLevel && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Cannot invite user with equal or higher access level' });
    }

    const existingUser = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existingUser) {
      return res.status(409).json({ error: 'User with this email already exists' });
    }

    const inviteToken = uuidv4();
    const inviteExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const targetHotelId = req.user.role === 'SUPER_ADMIN' ? hotelId : req.user.hotelId;

    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        name,
        role,
        accessLevel: roleLevel,
        hotelId: targetHotelId || null,
        inviteToken,
        inviteExpiry,
        isVerified: false,
      },
      include: { hotel: { select: { name: true } } },
    });

    // Send invite email
    const inviteUrl = `${process.env.FRONTEND_URL}/register?token=${inviteToken}`;
    await sendInviteEmail(user.email, user.name, inviteUrl, user.hotel?.name);

    const { passwordHash, inviteToken: _token, ...safeUser } = user;
    res.status(201).json({ user: safeUser, inviteUrl });
  } catch (err) {
    console.error('Invite error:', err);
    res.status(500).json({ error: 'Failed to create invite' });
  }
});

// UPDATE user (Level 7+, can only update lower level users)
router.put('/:id', authenticate, requireLevel(7), async (req, res) => {
  try {
    const { name, role, hotelId, isVerified } = req.body;
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) return res.status(404).json({ error: 'User not found' });

    if (target.accessLevel >= req.user.accessLevel && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Cannot edit user with equal or higher access' });
    }

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

// DELETE user (Super Admin only)
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

// RESEND invite
router.post('/:id/resend-invite', authenticate, requireLevel(7), async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: { hotel: true },
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
    await sendInviteEmail(user.email, user.name, inviteUrl, user.hotel?.name);

    res.json({ message: 'Invite resent', inviteUrl });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resend invite' });
  }
});

async function sendInviteEmail(email, name, inviteUrl, hotelName) {
  if (!process.env.SMTP_HOST) {
    console.log(`[Email] Invite URL for ${email}: ${inviteUrl}`);
    return;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    await transporter.sendMail({
      from: process.env.SMTP_FROM || 'Anchor Hotel Suite <noreply@anchorhotelsuite.com>',
      to: email,
      subject: `You're invited to Anchor Hotel Suite${hotelName ? ` - ${hotelName}` : ''}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:auto;">
          <h1 style="color:#1a3a5c;">🏨 Anchor Hotel Suite</h1>
          <p>Hi <strong>${name}</strong>,</p>
          <p>You have been invited to join <strong>${hotelName || 'Anchor Hotel Suite'}</strong>.</p>
          <p>Click the button below to set up your biometric login:</p>
          <a href="${inviteUrl}" style="display:inline-block;padding:12px 24px;background:#1a3a5c;color:white;text-decoration:none;border-radius:6px;margin:16px 0;">
            Accept Invite & Register
          </a>
          <p style="color:#666;font-size:0.875rem;">This link expires in 7 days.</p>
          <hr style="border:1px solid #eee;margin:24px 0;">
          <p style="color:#999;font-size:0.75rem;">Anchor Hotel Suite — Secure Property Management</p>
        </div>
      `,
    });
  } catch (err) {
    console.error('Email send failed:', err.message);
  }
}

export default router;
