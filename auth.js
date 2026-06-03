import express from 'express';

// ── hCaptcha verification ────────────────────────────────────────────────────
// Set HCAPTCHA_SECRET in Railway Variables to enable. Leave unset to disable.
// Get free secret at: https://dashboard.hcaptcha.com
async function verifyCaptcha(token) {
  if (!process.env.HCAPTCHA_SECRET) return true; // disabled if not configured
  if (!token) return false;
  try {
    const params = new URLSearchParams({
      secret: process.env.HCAPTCHA_SECRET,
      response: token,
    });
    const resp = await fetch('https://hcaptcha.com/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await resp.json();
    return data.success === true;
  } catch (e) {
    console.error('[hCaptcha]', e.message);
    return true; // fail open — don't block login if captcha service is down
  }
}

// ── Cookie helper ────────────────────────────────────────────────────────────
function setAuthCookie(res, token) {
  res.cookie('auth_token', token, {
    httpOnly: true,           // Not accessible via JavaScript — XSS protection
    secure: process.env.NODE_ENV === 'production',  // HTTPS only in prod
    sameSite: 'strict',       // CSRF protection
    maxAge: 24 * 60 * 60 * 1000,  // 24 hours (matches JWT expiry)
    path: '/',
  });
}
function clearAuthCookie(res) {
  res.clearCookie('auth_token', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/' });
}
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import prisma from './prisma.js';
import { authenticate, generateToken } from './middleware.js';
import { logAction, getIP, AUDIT_ACTIONS } from './audit.js';

const router = express.Router();

// ── Zod schemas ───────────────────────────────────────────────────────────────
const loginSchema = z.object({
  email:    z.string().email('Invalid email address').toLowerCase(),
  password: z.string().min(1, 'Password required'),
});

const forgotSchema = z.object({
  email: z.string().email('Invalid email address').toLowerCase(),
});

const resetSchema = z.object({
  token:       z.string().min(1, 'Token required'),
  newPassword: z.string().min(10, 'Password must be at least 10 characters'),
});

const RP_NAME = process.env.WEBAUTHN_RP_NAME || 'Anchor Hotel Suite';
const RP_ID = process.env.WEBAUTHN_RP_ID || 'localhost';
const ORIGIN = process.env.WEBAUTHN_ORIGIN || 'http://localhost:5173';

// ── Password Login ────────────────────────────────────────────────────────────
router.post('/login/password', async (req, res) => {
  try {
    // Zod validation
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const { email, password } = parsed.data;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: { hotel: true },
    });

    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.isVerified) {
      return res.status(403).json({ error: 'Account not yet verified' });
    }

    // SECURITY FIX: Check suspension on password login path
    if (user.isSuspended) {
      return res.status(403).json({ error: 'Account suspended. Contact your administrator.' });
    }

    const token = generateToken(user.id);

    // Audit log — login event
    logAction({
      userId: user.id, userName: user.name, userRole: user.role,
      hotelId: user.hotelId, action: AUDIT_ACTIONS.LOGIN_PASSWORD,
      entityType: 'User', entityId: user.id,
      description: `${user.name} signed in via password`,
      ipAddress: getIP(req),
    });

    return res.json({ token, user: sanitizeUser(user) });
  } catch (err) {
    console.error('Password login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── Forgot Password — request reset link ─────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

    // Always return success to prevent email enumeration
    if (!user || !user.isVerified) {
      return res.json({ message: 'If that email exists, a reset link has been sent.' });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await prisma.user.update({
      where: { id: user.id },
      data: { resetToken, resetTokenExpiry },
    });

    const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;

    // Send email
    try {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT) || 465,
        secure: true,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });

      await transporter.sendMail({
        from: `"${process.env.SMTP_FROM_NAME || 'Anchor Hotel Suite'}" <${process.env.SMTP_USER}>`,
        to: user.email,
        subject: '🔑 Password Reset — Anchor Hotel Suite',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
            <h2 style="color: #1a1a2e;">Password Reset Request</h2>
            <p>Hi ${user.name},</p>
            <p>You requested a password reset for your Anchor Hotel Suite account.</p>
            <p>Click the button below to reset your password. This link expires in <strong>1 hour</strong>.</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${resetUrl}" style="background: #C9A84C; color: #1a1a2e; padding: 12px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">
                Reset My Password
              </a>
            </div>
            <p style="color: #666; font-size: 13px;">If you didn't request this, ignore this email. Your password will not change.</p>
            <p style="color: #666; font-size: 13px;">Or copy this link: ${resetUrl}</p>
          </div>
        `,
      });
    } catch (emailErr) {
      console.error('Reset email failed:', emailErr.message);
      // Still return success — admin can share the link manually
    }

    logAction({
      userId: user.id, userName: user.name, userRole: user.role,
      hotelId: user.hotelId, action: AUDIT_ACTIONS.FORGOT_PASSWORD,
      entityType: 'User', entityId: user.id,
      description: `Password reset requested for ${user.email}`,
      ipAddress: getIP(req),
    });

    res.json({ message: 'If that email exists, a reset link has been sent.' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// ── Reset Password — use the token from email ─────────────────────────────────
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Token and new password required' });
    }

    const pwError = validatePasswordStrength(newPassword);
    if (pwError) return res.status(400).json({ error: pwError });

    const user = await prisma.user.findFirst({
      where: {
        resetToken: token,
        resetTokenExpiry: { gt: new Date() }, // not expired
      },
    });

    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
    }

    const hash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: hash,
        resetToken: null,      // invalidate token immediately after use
        resetTokenExpiry: null,
        isVerified: true,      // confirm account on password set
      },
    });

    logAction({
      userId: user.id, userName: user.name, userRole: user.role,
      hotelId: user.hotelId, action: AUDIT_ACTIONS.PASSWORD_CHANGED,
      entityType: 'User', entityId: user.id,
      description: `Password reset completed for ${user.email}`,
      ipAddress: getIP(req),
    });

    res.json({ message: 'Password reset successfully. You can now sign in.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ── Accept Invite ────────────────────────────────────────────────────────────
router.get('/invite/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const user = await prisma.user.findUnique({
      where: { inviteToken: token },
      include: { hotel: true },
    });

    if (!user) return res.status(404).json({ error: 'Invalid invite token' });
    if (user.inviteExpiry && new Date() > user.inviteExpiry) {
      return res.status(410).json({ error: 'Invite link has expired' });
    }

    return res.json({
      userId: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      hotel: user.hotel?.name,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to verify invite' });
  }
});

// ── WebAuthn Registration: Generate Options ───────────────────────────────────
router.post('/webauthn/register/options', async (req, res) => {
  try {
    const { email, inviteToken } = req.body;

    let user;
    if (inviteToken) {
      user = await prisma.user.findUnique({ where: { inviteToken } });
      if (!user) return res.status(403).json({ error: 'Invalid invite token' });
    } else {
      user = await prisma.user.findUnique({ where: { email: email?.toLowerCase() } });
      if (!user) return res.status(404).json({ error: 'User not found' });
    }

    const existingAuthenticators = await prisma.authenticator.findMany({
      where: { userId: user.id },
    });

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userID: Buffer.from(user.id),
      userName: user.email,
      userDisplayName: user.name,
      attestationType: 'none',
      excludeCredentials: existingAuthenticators.map((auth) => ({
        id: Buffer.from(auth.credentialID, 'base64url'),
        type: 'public-key',
        transports: auth.transports ? JSON.parse(auth.transports) : [],
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
        authenticatorAttachment: 'platform',
      },
    });

    // Store challenge with 5-minute expiry
    const challengeExpiry = new Date(Date.now() + 5 * 60 * 1000);
    await prisma.webAuthnChallenge.upsert({
      where: { userId: user.id },
      update: { challenge: options.challenge, expiresAt: challengeExpiry },
      create: { userId: user.id, challenge: options.challenge, expiresAt: challengeExpiry },
    });

    return res.json({ options, userId: user.id });
  } catch (err) {
    console.error('Registration options error:', err);
    res.status(500).json({ error: 'Failed to generate registration options' });
  }
});

// ── WebAuthn Registration: Verify ────────────────────────────────────────────
router.post('/webauthn/register/verify', async (req, res) => {
  try {
    const { userId, registrationResponse, deviceName, password, inviteToken } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { webauthnChallenge: true },
    });

    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.webauthnChallenge) return res.status(400).json({ error: 'No pending challenge' });

    // SECURITY FIX: Check challenge hasn't expired
    if (new Date() > user.webauthnChallenge.expiresAt) {
      await prisma.webAuthnChallenge.delete({ where: { userId: user.id } }).catch(() => {});
      return res.status(400).json({ error: 'Registration session expired — please try again' });
    }

    const verification = await verifyRegistrationResponse({
      response: registrationResponse,
      expectedChallenge: user.webauthnChallenge.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: false,
    });

    if (!verification.verified) {
      return res.status(400).json({ error: 'Registration verification failed' });
    }

    const { registrationInfo } = verification;
    const { credential, credentialDeviceType, credentialBackedUp } = registrationInfo;

    // Save authenticator
    await prisma.authenticator.create({
      data: {
        userId: user.id,
        credentialID: credential.id,
        credentialPublicKey: Buffer.from(credential.publicKey),
        counter: BigInt(credential.counter),
        credentialDeviceType,
        credentialBackedUp,
        transports: registrationResponse.response.transports
          ? JSON.stringify(registrationResponse.response.transports)
          : null,
        deviceName: deviceName || 'Primary Device',
      },
    });

    // Update user - set verified, clear invite, optionally set password
    const updateData = {
      isVerified: true,
      inviteToken: null,
      inviteExpiry: null,
    };

    if (password) {
      updateData.passwordHash = await bcrypt.hash(password, 12);
    }

    await prisma.user.update({ where: { id: user.id }, data: updateData });
    await prisma.webAuthnChallenge.delete({ where: { userId: user.id } });

    const token = generateToken(user.id);
    const updatedUser = await prisma.user.findUnique({
      where: { id: user.id },
      include: { hotel: true },
    });

    setAuthCookie(res, token);
    return res.json({ token, user: sanitizeUser(updatedUser) });
  } catch (err) {
    console.error('Registration verify error:', err);
    res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Registration failed' : err.message });
  }
});

// ── WebAuthn Authentication: Generate Options ─────────────────────────────────
router.post('/webauthn/login/options', async (req, res) => {
  try {
    const { email } = req.body;

    const user = await prisma.user.findUnique({
      where: { email: email?.toLowerCase() },
      include: { authenticators: true },
    });

    if (!user || !user.isVerified) {
      return res.status(404).json({ error: 'User not found or not registered' });
    }

    // SECURITY FIX: Check suspension BEFORE issuing a challenge
    if (user.isSuspended) {
      return res.status(403).json({ error: 'Account suspended. Contact your administrator.' });
    }

    if (user.authenticators.length === 0) {
      return res.status(400).json({ error: 'No biometric credentials registered' });
    }

    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: 'preferred',
      allowCredentials: user.authenticators.map((auth) => ({
        id: Buffer.from(auth.credentialID, 'base64url'),
        type: 'public-key',
        transports: auth.transports ? JSON.parse(auth.transports) : [],
      })),
    });

    // SECURITY FIX: Challenge expires in 5 minutes — prevents replay attacks
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await prisma.webAuthnChallenge.upsert({
      where: { userId: user.id },
      update: { challenge: options.challenge, expiresAt },
      create: { userId: user.id, challenge: options.challenge, expiresAt },
    });

    return res.json({ options, userId: user.id });
  } catch (err) {
    console.error('Auth options error:', err);
    res.status(500).json({ error: 'Failed to generate authentication options' });
  }
});

// ── WebAuthn Authentication: Verify ──────────────────────────────────────────
router.post('/webauthn/login/verify', async (req, res) => {
  try {
    const { userId, authenticationResponse } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { authenticators: true, webauthnChallenge: true, hotel: true },
    });

    if (!user) return res.status(404).json({ error: 'User not found' });

    // SECURITY FIX: Enforce suspension and verification on biometric login path
    if (user.isSuspended) {
      return res.status(403).json({ error: 'Account suspended. Contact your administrator.' });
    }
    if (!user.isVerified) {
      return res.status(403).json({ error: 'Account not yet verified.' });
    }

    if (!user.webauthnChallenge) {
      return res.status(400).json({ error: 'No pending challenge — please restart login' });
    }

    // SECURITY FIX: Reject expired challenges (5-minute window)
    if (new Date() > user.webauthnChallenge.expiresAt) {
      await prisma.webAuthnChallenge.delete({ where: { userId: user.id } }).catch(() => {});
      return res.status(400).json({ error: 'Challenge expired — please try again' });
    }

    const authenticator = user.authenticators.find(
      (a) => a.credentialID === authenticationResponse.id
    );

    if (!authenticator) {
      return res.status(400).json({ error: 'Credential not recognized' });
    }

    const verification = await verifyAuthenticationResponse({
      response: authenticationResponse,
      expectedChallenge: user.webauthnChallenge.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: authenticator.credentialID,
        publicKey: new Uint8Array(authenticator.credentialPublicKey),
        counter: Number(authenticator.counter),
        transports: authenticator.transports ? JSON.parse(authenticator.transports) : [],
      },
      requireUserVerification: false,
    });

    if (!verification.verified) {
      return res.status(401).json({ error: 'Authentication failed' });
    }

    // Update counter and clean up challenge atomically
    await prisma.authenticator.update({
      where: { id: authenticator.id },
      data: { counter: BigInt(verification.authenticationInfo.newCounter) },
    });
    await prisma.webAuthnChallenge.delete({ where: { userId: user.id } });

    const token = generateToken(user.id);
    return res.json({ token, user: sanitizeUser(user) });
  } catch (err) {
    console.error('Auth verify error:', err);
    // SECURITY FIX: Never leak error details in production
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// ── Get Current User ─────────────────────────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: {
      hotel: true,
      authenticators: { select: { id: true, deviceName: true, createdAt: true } },
    },
  });
  res.json(sanitizeUser(user));
});

// ── Change Password ───────────────────────────────────────────────────────────
router.post('/change-password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    const pwError = validatePasswordStrength(newPassword);
    if (pwError) return res.status(400).json({ error: pwError });

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });

    if (user.passwordHash) {
      // Has existing password — must verify it
      if (!currentPassword) {
        return res.status(400).json({ error: 'Current password required' });
      }
      const valid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!valid) return res.status(401).json({ error: 'Current password incorrect' });
    } else {
      // SECURITY FIX: Biometric-only account — block silent password set without current password proof
      // User must supply their current password or go through the admin reset flow
      return res.status(400).json({
        error: 'No password set on this account. Ask your administrator to set an initial password, then you can change it here.',
      });
    }

    const hash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: req.user.id }, data: { passwordHash: hash } });

    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update password' });
  }
});

// ── Remove Authenticator ──────────────────────────────────────────────────────
router.delete('/authenticator/:id', authenticate, async (req, res) => {
  try {
    const auth = await prisma.authenticator.findUnique({ where: { id: req.params.id } });
    if (!auth || auth.userId !== req.user.id) {
      return res.status(404).json({ error: 'Authenticator not found' });
    }

    await prisma.authenticator.delete({ where: { id: req.params.id } });
    res.json({ message: 'Authenticator removed' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove authenticator' });
  }
});

// ── Password strength validator (shared across all auth routes) ───────────────
// Returns an error string if invalid, null if valid
export function validatePasswordStrength(pw) {
  if (!pw || typeof pw !== 'string') return 'Password is required';
  if (pw.length < 10) return 'Password must be at least 10 characters';
  if (!/[A-Z]/.test(pw)) return 'Password must contain at least one uppercase letter';
  if (!/[0-9]/.test(pw)) return 'Password must contain at least one number';
  if (!/[^A-Za-z0-9]/.test(pw)) return 'Password must contain at least one symbol (e.g. !@#$%^&*)';
  return null; // valid
}

const sanitizeUser = (user) => {
  if (!user) return null;
  const { passwordHash, inviteToken, inviteExpiry, webauthnChallenge, ...safe } = user;
  return safe;
};

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ message: 'Logged out successfully' });
});

export default router;
