/**
 * SSO Routes — AISA Backend
 *
 * TWO endpoints:
 *  1. POST /api/auth/sso/generate  — Called by AISA frontend (authenticated user)
 *     → Generates a SHORT-LIVED (60s) signed handoff token.
 *
 *  2. POST /api/auth/sso/handoff   — Called by the AIMALL frontend (incoming user)
 *     → Verifies the short-lived token, JIT-provisions the user in AISA's DB,
 *       and issues a full AISA session JWT.
 */

import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import UserModel from '../models/User.js';
import generateTokenAndSetCookies from '../utils/generateTokenAndSetCookies.js';
import { createSession } from '../utils/sessionHelper.js';

const router = express.Router();

// ─── Shared SSO secret (must match AIMALL backend's SSO_SECRET) ─────────────────
const getSsoSecret = () => {
  const secret = process.env.SSO_SECRET || process.env.JWT_SECRET;
  if (!secret || secret === 'fallback_secret') {
    console.warn('[SSO] WARNING: SSO_SECRET not set! Using insecure fallback.');
  }
  return secret || 'sso_fallback_secret_CHANGE_ME';
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. POST /api/auth/sso/generate
//    Protected: requires a valid Bearer token (the user's existing AISA session)
//    Returns:  { sso_token: "..." } — a 60-second handoff token
// ─────────────────────────────────────────────────────────────────────────────
router.post('/generate', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const sessionToken = authHeader.slice(7);

  let sessionPayload;
  try {
    sessionPayload = jwt.verify(sessionToken, process.env.JWT_SECRET || 'fallback_secret');
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session token' });
  }

  const { email, name, id } = sessionPayload;
  if (!email) {
    return res.status(400).json({ error: 'Session token missing email claim' });
  }

  // Issue a short-lived SSO handoff token (60 seconds, different audience)
  const ssoToken = jwt.sign(
    {
      sub: id || email,
      email,
      name: name || email.split('@')[0],
      iss: 'aisa',
      aud: 'sso-handoff',
    },
    getSsoSecret(),
    { expiresIn: '60s' }
  );

  console.log(`[SSO] Generated handoff token for ${email}`);
  return res.status(200).json({ sso_token: ssoToken });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. POST /api/auth/sso/handoff
//    Public (sso_token IS the proof of identity)
//    Body: { sso_token: "...", from: "aimall" }
//    Returns: { token: "...", user: {...} }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/handoff', async (req, res) => {
  const { sso_token, from } = req.body;

  if (!sso_token) {
    return res.status(400).json({ error: 'Missing sso_token' });
  }

  const allowedSources = ['aisa', 'aimall'];
  if (from && !allowedSources.includes(from)) {
    return res.status(400).json({ error: `Unknown SSO source: ${from}` });
  }

  let decoded;
  try {
    decoded = jwt.verify(sso_token, getSsoSecret(), {
      audience: 'sso-handoff',
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'SSO token has expired. Please click the toggle again.' });
    }
    console.warn(`[SSO] Invalid handoff token from "${from}": ${err.message}`);
    return res.status(401).json({ error: 'Invalid SSO token', details: err.message });
  }

  const { email, name } = decoded;
  if (!email) {
    return res.status(400).json({ error: 'SSO token missing email claim' });
  }

  try {
    // JIT Provisioning
    let user = await UserModel.findOne({ email });

    if (!user) {
      console.log(`[SSO] JIT provisioning AISA user → ${email} (from: ${from})`);
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(crypto.randomBytes(20).toString('hex'), salt);
      user = await UserModel.create({
        name: name || email.split('@')[0],
        email,
        password: hashedPassword,
        isVerified: true,
      });
    } else {
      user.lastLogin = new Date();
      await user.save();
    }

    // Issue a full AISA session JWT
    const sessionToken = generateTokenAndSetCookies(
      res,
      user._id,
      user.email,
      user.name,
      user.plan || 'Basic',
      user.role || 'user'
    );

    // Track Session so it isn't immediately revoked
    await createSession(user._id, sessionToken, req);

    console.log(`[SSO] ✅ AISA handoff successful → ${email} (from: ${from})`);

    return res.status(200).json({
      token: sessionToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role || 'user',
        plan: user.plan || 'Basic',
        avatar: user.avatar || null,
        token: sessionToken,
      },
    });
  } catch (err) {
    console.error('[SSO] AISA handoff error:', err);
    return res.status(500).json({ error: 'SSO handoff failed', details: err.message });
  }
});

export default router;
