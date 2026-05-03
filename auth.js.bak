import express from 'express';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import bcrypt from 'bcryptjs';
import prisma from './prisma.js';
import { authenticate, generateToken } from './middleware.js';

const router = express.Router();

const RP_NAME = process.env.WEBAUTHN_RP_NAME || 'Anchor Hotel Suite';
const RP_ID = process.env.WEBAUTHN_RP_ID || 'localhost';
const ORIGIN = process.env.WEBAUTHN_ORIGIN || 'http://localhost:5173';

// ── Password Login (Super Admin / Laptop fallback) ───────────────────────────
router.post('/login/password', async (req, res) => {
  try {
    const { email, password } = req.body;
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

    const token = generateToken(user.id);
    return res.json({
      token,
      user: sanitizeUser(user),
    });
  } catch (err) {
    console.error('Password login error:', err);
    res.status(500).json({ error: 'Login failed' });
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

    // Store challenge
    await prisma.webAuthnChallenge.upsert({
      where: { userId: user.id },
      update: { challenge: options.challenge },
      create: { userId: user.id, challenge: options.challenge },
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

    return res.json({ token, user: sanitizeUser(updatedUser) });
  } catch (err) {
    console.error('Registration verify error:', err);
    res.status(500).json({ error: 'Registration failed: ' + err.message });
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

    await prisma.webAuthnChallenge.upsert({
      where: { userId: user.id },
      update: { challenge: options.challenge },
      create: { userId: user.id, challenge: options.challenge },
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
    if (!user.webauthnChallenge) return res.status(400).json({ error: 'No pending challenge' });

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

    // Update counter
    await prisma.authenticator.update({
      where: { id: authenticator.id },
      data: { counter: BigInt(verification.authenticationInfo.newCounter) },
    });

    await prisma.webAuthnChallenge.delete({ where: { userId: user.id } });

    const token = generateToken(user.id);
    return res.json({ token, user: sanitizeUser(user) });
  } catch (err) {
    console.error('Auth verify error:', err);
    res.status(500).json({ error: 'Authentication failed: ' + err.message });
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
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });

    if (user.passwordHash) {
      const valid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!valid) return res.status(401).json({ error: 'Current password incorrect' });
    }

    const hash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({
      where: { id: req.user.id },
      data: { passwordHash: hash },
    });

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

const sanitizeUser = (user) => {
  const { passwordHash, inviteToken, ...safe } = user;
  return safe;
};

export default router;
