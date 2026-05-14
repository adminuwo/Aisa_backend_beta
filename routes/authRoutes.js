import express from "express";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import UserModel from "../models/User.js";
import generateTokenAndSetCookies from "../utils/generateTokenAndSetCookies.js";
import { generateOTP } from "../utils/verifiacitonCode.js";
import { sendVerificationEmail, sendResetPasswordEmail, sendPasswordChangeSuccessEmail, sendResetPasswordOTP } from "../utils/Email.js";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import axios from "axios";
import { uploadToGCS, gcsFilename } from "../services/gcs.service.js";
import { OAuth2Client } from "google-auth-library";
import { getSmartAvatar, isGeneratedAvatar } from "../utils/avatarHelper.js";
import { verifyToken } from "../middleware/authorization.js";
import { createSession } from "../utils/sessionHelper.js";
import appleSignin from 'apple-signin-auth';

const router = express.Router();
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// --- Avatar Helpers moved to utils/avatarHelper.js ---

// --- Proxy Avatar Route ---
router.get("/proxy-avatar", async (req, res) => {
  const { email, name } = req.query;
  if (!email) return res.redirect("/User.jpeg");
  
  const normalizedEmail = email.trim().toLowerCase();
  const initials = name ? name.trim().split(/\s+/).map(n => n[0]).join('').toUpperCase().slice(0, 2) : normalizedEmail.slice(0, 2).toUpperCase();
  const fallback = `https://ui-avatars.com/api/?name=${encodeURIComponent(initials || "U")}&background=random&color=fff&size=256`;

  // For real-time previews, we don't upload to Cloudinary (too slow)
  // We just redirect to the best guess
  const sources = [
    normalizedEmail.endsWith('@gmail.com') ? `https://www.google.com/s2/photos/profile/${normalizedEmail}?sz=256` : null,
    `https://www.gravatar.com/avatar/${crypto.createHash('md5').update(normalizedEmail).digest('hex')}?d=404`
  ].filter(Boolean);

  for (const source of sources) {
    try {
      // Check if source exists with a quick HEAD request
      const head = await axios.head(source, { timeout: 2000 });
      if (head.status === 200) return res.redirect(source);
    } catch (e) {}
  }

  return res.redirect(fallback);
});

// Test routes
router.get("/", (req, res) => {
  res.send("This is the auth");
});

router.get("/signup", (req, res) => {
  res.send("this is signup");
});

// ====================== SIGNUP =======================
router.post("/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // DB Down Fallback for Signup
    if (mongoose.connection.readyState !== 1) {
      console.log("[DB] MongoDB unreachable during signup. Granting temporary access.");
      const demoId = new mongoose.Types.ObjectId().toString();
      const token = generateTokenAndSetCookies(res, demoId, email, name);
      return res.status(201).json({
        id: demoId,
        name: name || "Demo User",
        email: email,
        message: "Demo Mode: Verification bypassed due to DB status",
        token: token,
      });
    }

    // Check user exists
    const existingUser = await UserModel.findOne({ email });

    if (existingUser) {
      return res.status(400).json({ error: "User Already Exists With This Email" });
    }

    // Password Validation
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    if (!passwordRegex.test(password)) {
      return res.status(400).json({
        error: "Password must be at least 8 characters long and include an uppercase letter, a lowercase letter, a number, and a special character."
      });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const verificationCode = generateOTP();

    // Create user
    const newUser = await UserModel.create({
      name,
      email,
      password: hashedPassword,
      verificationCode,
      credits: 500, // Explicitly set to match README Free Tier
      avatar: await getSmartAvatar(email, name),
      notificationsInbox: [
        {
          id: `welcome_${Date.now()}_1`,
          title: 'Welcome to AISA!',
          desc: 'Start your journey with your Artificial Intelligence Super Assistant. Need help? Ask us anything!',
          type: 'promo',
          time: new Date()
        }
      ]
    });

    // 📝 Log Initial Free Credits
    try {
      const CreditLog = (await import('../models/CreditLog.js')).default;
      await CreditLog.create({
        userId: newUser._id,
        action: 'bonus',
        description: 'New User Bonus (Free Tier)',
        credits: 500,
        balanceAfter: 500
      });
    } catch (logErr) {
      console.error('Initial CreditLog failed:', logErr.message);
    }

    // Generate token cookie
    const token = generateTokenAndSetCookies(res, newUser._id, newUser.email, newUser.name, newUser.plan, newUser.role);


    // Send OTP email
    await sendVerificationEmail(newUser.email, newUser.name, newUser.verificationCode);

    res.status(201).json({
      id: newUser._id,
      name: newUser.name,
      email: newUser.email,
      message: "Verification code sent successfully",
      token: token,
      plan: newUser.plan,
    });
  } catch (err) {
    console.error("Signup Error:", err);
    res.status(500).json({ error: "Server error during signup" });
  }
});

// ====================== LOGIN =======================
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    // DB Down Fallback for Login
    if (mongoose.connection.readyState !== 1) {
      console.log("[DB] MongoDB unreachable during login. Granting temporary access.");
      const demoId = new mongoose.Types.ObjectId().toString();
      const token = generateTokenAndSetCookies(res, demoId, email, "Demo User");
      return res.status(201).json({
        id: demoId,
        name: "Demo User",
        email: email,
        message: "LogIn Successfully (Demo Mode)",
        token: token,
        role: "user"
      });
    }

    // Find user
    const user = await UserModel.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: "Account not found with this email" });
    }

    // Compare hashed password
    const isCorrect = await bcrypt.compare(password, user.password);
    if (!isCorrect) {
      return res.status(401).json({ error: "Incorrect password" });
    }

    // Remove normalisePlan
    const userPlan = user.plan || "Basic";
    // Generate token
    const token = generateTokenAndSetCookies(res, user._id, user.email, user.name, userPlan, user.role);

    // Track Session
    await createSession(user._id, token, req);

    // Add welcome notifications if inbox is empty
    if (!user.notificationsInbox || user.notificationsInbox.length === 0) {
      user.notificationsInbox = [
        {
          id: `welcome_${Date.now()}_1`,
          title: 'Welcome to AISA!',
          desc: 'Start your journey with your Artificial Intelligence Super Assistant. Need help? Ask us anything!',
          type: 'promo',
          time: new Date()
        },
        {
          id: `welcome_${Date.now()}_2`,
          title: 'AISA v2.4.0 is here!',
          desc: 'New features: Dynamic Accent Colors and improved Voice Synthesis are now live. Check them out in General settings.',
          type: 'update',
          time: new Date(Date.now() - 7200000)
        },
        {
          id: `welcome_${Date.now()}_3`,
          title: 'Plan Expiring Soon',
          desc: 'Your "Pro" plan will end in 3 days. Renew now to keep enjoying unlimited AI access.',
          type: 'alert',
          time: new Date(Date.now() - 3600000)
        },
      ];
    }

    // Add "New Login" notification
    user.notificationsInbox.unshift({
      id: `login_${Date.now()}`,
      title: 'New Login Detected',
      desc: `Successfully logged in at ${new Date().toLocaleTimeString()}`,
      type: 'alert', // efficient check icon
      time: new Date(),
      isRead: false
    });

    // Limit inbox size
    if (user.notificationsInbox.length > 50) {
      user.notificationsInbox = user.notificationsInbox.slice(0, 50);
    }

    // Proactively update avatar if it's generated/default
    if (isGeneratedAvatar(user.avatar)) {
      user.avatar = await getSmartAvatar(user.email, user.name);
      await user.save();
    }

    res.status(201).json({
      id: user._id,
      name: user.name,
      email: user.email,
      message: "LogIn Successfully",
      token: token,
      role: user.role,
      plan: user.plan,
      avatar: user.avatar,
      notifications: user.notificationsInbox
    });

  } catch (err) {
    console.error("Login Error:", err);
    res.status(500).json({ error: "Server error during login" });
  }
});

// ====================== SOCIAL AUTH (Google, Facebook, GitHub, etc.) =======================

/**
 * Common handler to find or create a user after any social authentication
 */
const handleSocialUser = async (profile, req, res, isRedirect = true) => {
  const { email, name, picture, provider, providerId } = profile;

  if (!email) {
    return res.status(400).json({ error: "Email is required from social provider" });
  }

  try {
    // 1. Check if user already has this specific social account linked
    let user = await UserModel.findOne({
      $or: [
        { "socialLinks.provider": provider, "socialLinks.providerId": providerId },
        { provider, providerId }
      ]
    });

    if (!user) {
      // 2. Check if a user exists with the same email (Account Linking)
      user = await UserModel.findOne({ email });

      if (user) {
        // Always check for picture updates if current is generated
        if (isGeneratedAvatar(user.avatar) && picture) {
          if (picture.includes('googleusercontent.com') || picture.includes('fbcdn.net') || picture.includes('twimg.com') || picture.includes('microsoft.com')) {
            try {
              const avatarRes = await axios.get(picture, { responseType: 'arraybuffer', timeout: 5000 });
              const buffer = Buffer.from(avatarRes.data);
              const gcsRes = await uploadToGCS(buffer, {
                folder: 'user_avatars',
                filename: gcsFilename(`avatar_social_${user.email.split('@')[0]}`),
                mimeType: avatarRes.headers['content-type'] || 'image/jpeg',
              });
              user.avatar = gcsRes.publicUrl;
            } catch (e) {
              user.avatar = picture; 
            }
          } else {
            user.avatar = picture;
          }
        }

        if (user.provider !== provider.toLowerCase()) {
          console.log(`[Social Auth] Linking ${provider.toUpperCase()} account to existing user: ${email}`);
          if (!user.socialLinks) user.socialLinks = [];
          if (!user.socialLinks.some(s => s.provider === provider.toLowerCase())) {
            user.socialLinks.push({ provider, providerId });
          }
          user.provider = provider.toLowerCase();
          user.providerId = providerId;
        }

        user.isVerified = true;
        await user.save();
      } else {
        // 3. Create new user
        console.log(`[Social Auth] Creating new user via ${provider.toUpperCase()}: ${email}`);
        user = await UserModel.create({
          name: name || `${provider} User`,
          email: email,
          password: crypto.randomBytes(16).toString("hex"), // Secure random password
          credits: 500, // Explicitly set to match README Free Tier
          avatar: picture || `https://ui-avatars.com/api/?name=${encodeURIComponent(name || 'User')}&background=random`,
          isVerified: true,
          provider: provider.toLowerCase(),
          providerId: providerId,
          socialLinks: [{ provider, providerId }],
          notificationsInbox: [
            {
              id: `welcome_${Date.now()}`,
              title: `Welcome to AISA via ${provider}!`,
              desc: 'Your account has been successfully created. Explore our AI features!',
              type: 'update',
              time: new Date()
            }
          ]
        });

        // 📝 Log Initial Free Credits
        try {
          const CreditLog = (await import('../models/CreditLog.js')).default;
          await CreditLog.create({
            userId: user._id,
            action: 'bonus',
            description: 'New User Bonus (Free Tier)',
            credits: 500,
            balanceAfter: 500
          });
        } catch (logErr) {
          console.error('Social Initial CreditLog failed:', logErr.message);
        }
      }
    }

    // Generate JWT
    const token = generateTokenAndSetCookies(res, user._id, user.email, user.name, user.plan, user.role);

    // Track Session
    await createSession(user._id, token, req);

    if (isRedirect) {
      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
      const redirectUrl = `${frontendUrl}/login?social_auth=true&token=${token}&userId=${user._id}&userName=${encodeURIComponent(user.name)}&userEmail=${user.email}&provider=${provider.toLowerCase()}&picture=${encodeURIComponent(user.avatar || "")}`;
      return res.redirect(redirectUrl);
    } else {
      return res.status(200).json({
        id: user._id,
        name: user.name,
        email: user.email,
        message: "Social Login Successfully",
        token: token,
        role: user.role,
        plan: user.plan,
        notifications: user.notificationsInbox,
        provider: user.provider
      });
    }
  } catch (err) {
    console.error(`[Social Auth Error] ${provider}:`, err);
    if (isRedirect) {
      const fallbackFrontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
      return res.redirect(`${fallbackFrontendUrl}/login?error=Authentication failed`);
    } else {
      return res.status(500).json({ error: "Authentication failed" });
    }
  }
};

// --- Real OAuth Helpers ---
const fetchGitHubProfile = async (code) => {
  const response = await axios.post('https://github.com/login/oauth/access_token', {
    client_id: process.env.GITHUB_CLIENT_ID,
    client_secret: process.env.GITHUB_CLIENT_SECRET,
    code
  }, { headers: { Accept: 'application/json' } });

  const accessToken = response.data.access_token;
  const userRes = await axios.get('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  // Emails might be private, fetch separately
  const emailRes = await axios.get('https://api.github.com/user/emails', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const primaryEmail = emailRes.data.find(e => e.primary)?.email || userRes.data.email;

  return {
    provider: 'github',
    providerId: userRes.data.id.toString(),
    name: userRes.data.name || userRes.data.login,
    email: primaryEmail,
    picture: userRes.data.avatar_url
  };
};

const fetchDiscordProfile = async (code) => {
  const params = new URLSearchParams();
  params.append('client_id', process.env.DISCORD_CLIENT_ID);
  params.append('client_secret', process.env.DISCORD_CLIENT_SECRET);
  params.append('grant_type', 'authorization_code');
  params.append('code', code);
  params.append('redirect_uri', `${process.env.BACKEND_URL}/api/auth/discord/callback`);

  const response = await axios.post('https://discord.com/api/oauth2/token', params);
  const accessToken = response.data.access_token;

  const userRes = await axios.get('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  return {
    provider: 'discord',
    providerId: userRes.data.id,
    name: userRes.data.username,
    email: userRes.data.email,
    picture: `https://cdn.discordapp.com/avatars/${userRes.data.id}/${userRes.data.avatar}.png`
  };
};

const fetchFacebookProfile = async (code) => {
  const tokenRes = await axios.get(`https://graph.facebook.com/v12.0/oauth/access_token`, {
    params: {
      client_id: process.env.FACEBOOK_APP_ID,
      client_secret: process.env.FACEBOOK_APP_SECRET,
      redirect_uri: `${process.env.BACKEND_URL}/api/auth/facebook/callback`,
      code
    }
  });

  const accessToken = tokenRes.data.access_token;
  const userRes = await axios.get(`https://graph.facebook.com/me`, {
    params: {
      access_token: accessToken,
      fields: 'id,name,email,picture.type(large)'
    }
  });

  return {
    provider: 'facebook',
    providerId: userRes.data.id,
    name: userRes.data.name,
    email: userRes.data.email,
    picture: userRes.data.picture?.data?.url
  };
};

// --- Simulation Template ---
const devLoginTemplate = (provider, email) => {
  const config = {
    GitHub: { color: '#24292e', logo: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12', bg: '#f6f8fa' },
    Facebook: { color: '#1877F2', logo: 'M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.469h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.469h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z', bg: '#ecf3ff' },
    Discord: { color: '#5865F2', logo: 'M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037 19.736 19.736 0 00-4.885 1.515.069.069 0 00-.032.027C.533 9.048-.32 13.572.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028 14.09 14.09 0 001.226-1.994.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128c.125-.094.252-.192.37-.294a.077.077 0 01.077-.01c3.927 1.793 8.18 1.793 12.062 0a.077.077 0 01.078.01c.12.102.246.2.373.294a.077.077 0 01-.006.127 12.298 12.298 0 01-1.873.893.077.077 0 00-.041.107 14.361 14.361 0 001.226 1.994.077.077 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03z', bg: '#36393f' },
    Microsoft: { color: '#00A4EF', logo: 'M11.4 24H0V12.6h11.4V24zM24 24H12.6V12.6H24V24zM11.4 11.4H0V0h11.4v11.4zM24 11.4H12.6V0H24v11.4z', bg: '#e6e6e6' },
    Apple: { color: '#000000', logo: 'm150.37 130.25c-2.45 5.66-5.35 10.87-8.71 15.66-4.58 6.53-8.33 11.05-11.22 13.56-4.48 4.12-9.28 6.23-14.42 6.35-3.69 0-8.14-1.05-13.32-3.18-5.197-2.12-9.973-3.17-14.34-3.17-4.58 0-9.492 1.05-14.746 3.17-5.254 2.13-9.49 3.29-12.71 3.48-5.253.39-10.37-1.77-15.35-6.47-3.04-2.79-6.79-7.14-11.24-13.06-4.45-5.91-8.25-12.51-11.41-19.78-3.15-7.26-4.73-14.85-4.73-22.77 0-10.73 2.53-19.89 7.58-27.48 4.09-6.13 9.42-10.66 15.98-13.59 6.57-2.93 13.25-4.4 20.03-4.4 4.04 0 9.06 1.05 15.08 3.14 6.02 2.1 10.15 3.15 12.39 3.15 1.48 0 5.8-1.12 12.96-3.37 7.16-2.25 13.3-3.23 18.42-2.93 13 1.08 23.36 6.3 31.06 15.65-11.52 6.93-17.28 17.06-17.28 30.38 0 10.18 3.03 18.67 9.09 25.44 3.04 3.42 6.78 6.24 11.23 8.48zm-26.65-103.11c0 8.08-3 15.82-8.99 23.23-7.55 9.06-16.14 14-25.75 14.86-.34-8.15 2.68-15.97 9.05-23.47 3.25-3.83 7.37-7.25 12.35-10.27 4.99-3.01 9.42-4.63 13.28-4.87.04.18.06.35.06.52z', viewBox: '0 0 170 170', bg: '#000000' },
    Twitter: { color: '#1DA1F2', logo: 'M23.953 4.57a10 10 0 01-2.825.775 4.958 4.958 0 002.163-2.723c-.951.555-2.005.959-3.127 1.184a4.92 4.92 0 00-8.384 4.482C7.69 8.095 4.067 6.13 1.64 3.162a4.822 4.822 0 00-.666 2.475c0 1.71.87 3.213 2.188 4.096a4.904 4.904 0 01-2.228-.616v.06a4.923 4.923 0 003.946 4.84 4.996 4.996 0 01-2.212.085 4.936 4.936 0 004.604 3.417 9.867 9.867 0 01-6.102 2.105c-.39 0-.779-.023-1.17-.067a13.995 13.995 0 007.557 2.209c9.053 0 13.998-74.96 13.998-13.985 0-.21 0-.42-.015-.63A9.935 9.935 0 0024 4.59z', bg: '#15202b' },
    LinkedIn: { color: '#0077B5', logo: 'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.454C23.205 24 24 23.227 24 22.271V1.729C24 .774 23.205 0 22.225 0z', bg: '#f3f6f8' }
  }[provider] || { color: '#4285F4', logo: '', bg: '#ffffff' };

  return `
<!DOCTYPE html>
<html>
<head>
    <title>Authorize AISA™ via ${provider}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { 
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica; 
            display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; 
            background: #f1f5f9; color: #1e293b; 
        }
        .card { 
            background: #fff; padding: 40px; 
            border-radius: 28px; 
            box-shadow: 0 25px 50px -12px rgba(0,0,0,0.08); 
            text-align: center; width: 420px; 
            border: 1px solid #e2e8f0;
            position: relative; animation: slideIn 0.4s ease-out;
        }
        @keyframes slideIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        
        .logo-svg { width: 64px; height: 64px; fill: ${config.color}; margin-bottom: 24px; }
        .title { font-size: 26px; font-weight: 800; margin-bottom: 8px; color: #0f172a; letter-spacing: -0.03em; }
        .subtitle { font-size: 15px; opacity: 0.6; margin-bottom: 32px; font-weight: 500; }
        
        .permission-box { text-align: left; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 20px; padding: 24px; margin-bottom: 32px; }
        .perm-item { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 16px; font-size: 14px; font-weight: 500; color: #475569; }
        .perm-icon { color: ${config.color}; font-weight: bold; margin-top: 2px; }
        
        .input-group { text-align: left; margin-bottom: 24px; }
        .input-group label { display: block; font-size: 12px; font-weight: 800; margin-bottom: 8px; color: #64748b; text-transform: uppercase; letter-spacing: 0.08em; }
        .input-group input { 
            width: 100%; padding: 16px; border-radius: 12px; 
            border: 1px solid #cbd5e1; background: #fff; color: #0f172a; 
            box-sizing: border-box; font-size: 16px; outline: none; transition: 0.2s;
        }
        .input-group input:focus { border-color: ${config.color}; box-shadow: 0 0 0 4px ${config.color}15; }

        .btn { 
            background: ${config.color}; color: white; border: none; padding: 18px; 
            border-radius: 14px; font-weight: 800; cursor: pointer; width: 100%; 
            font-size: 17px; transition: all 0.2s;
            box-shadow: 0 12px 24px -6px ${config.color}40;
        }
        .btn:hover { transform: translateY(-3px); box-shadow: 0 20px 30px -8px ${config.color}50; filter: brightness(1.1); }
        .btn:active { transform: translateY(-1px); }
        
        .profile-card { display: flex; align-items: center; gap: 16px; text-align: left; margin-bottom: 24px; }
        .avatar { width: 56px; height: 56px; border-radius: 50%; background: ${config.color}; border: 3px solid white; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1); display: flex; align-items: center; justify-content: center; color: white; font-weight: 900; overflow: hidden; }
        .info b { font-size: 17px; display: block; color: #0f172a; }
        .info span { font-size: 14px; color: #64748b; }
        
        .secondary-btn { background: transparent; color: #64748b; border: none; font-size: 13px; font-weight: 600; cursor: pointer; text-decoration: underline; margin-top: 16px; }
        .footer { font-size: 12px; color: #94a3b8; margin-top: 32px; font-weight: 600; letter-spacing: 0.02em; }
    </style>
</head>
<body>
    <!-- Screen 1: Identification (Only shows if no saved identity) -->
    <div class="card" id="login-card" style="display: none;">
        <svg class="logo-svg" viewBox="${config.viewBox || '0 0 24 24'}"><path d="${config.logo}"/></svg>
        <div class="title">Sign in with ${provider}</div>
        <div class="subtitle">Complete the handshake to sync with AISA™</div>
        
        <div class="input-group">
            <label>${provider} handle / Name</label>
            <input type="text" id="id-input" placeholder="e.g. dev_profile" autocomplete="off">
        </div>

        <button class="btn" onclick="goToConsent()">Next</button>
        <div class="footer">Simulation Mode • Verified AISA Bridge</div>
    </div>

    <!-- Screen 2: Consent (Shown immediately if already "logged in") -->
    <div class="card" id="auth-card" style="display: none;">
        <svg class="logo-svg" viewBox="${config.viewBox || '0 0 24 24'}"><path d="${config.logo}"/></svg>
        <div class="title">Authorize AISA™</div>
        <div class="subtitle">AISA™ is requesting the following permissions:</div>
        
        <div class="profile-card">
            <div class="avatar" id="avatar-init"><img id="profile-img" src="" style="width:100%; display:none;"></div>
            <div class="info">
                <span>Signed in as:</span>
                <b id="profile-name">GITHUB USER</b>
            </div>
        </div>

        <div class="permission-box">
            <div class="perm-item"><span class="perm-icon">✓</span> <div><b>Public Profile</b><br><small>Name, avatar, and unique ID</small></div></div>
            <div class="perm-item"><span class="perm-icon">✓</span> <div><b>Email Address</b><br><small>Primary email for synchronization</small></div></div>
        </div>

        <button class="btn" id="finish-btn" onclick="completeHandshake()">Authorize & Continue</button>
        <button class="secondary-btn" onclick="resetIdentity()">Sign in as someone else</button>
        <div class="footer">Secure Handshake Architecture • AISA Cloud</div>
    </div>

    <script>
        const providerName = '${provider}';
        const providerKey = '${provider.toLowerCase()}';
        
        function getSavedUser() {
            return localStorage.getItem('sim_user_' + providerKey);
        }

        function goToConsent() {
            const handle = document.getElementById('id-input').value;
            if(!handle) return alert('Please enter an identity handle');
            
            localStorage.setItem('sim_user_' + providerKey, handle);
            showConsentScreen(handle);
        }

        function showConsentScreen(handle) {
            document.getElementById('login-card').style.display = 'none';
            document.getElementById('auth-card').style.display = 'block';
            
            document.getElementById('profile-name').innerText = handle.toUpperCase() + ' (' + providerName + ')';
            document.getElementById('profile-img').src = 'https://ui-avatars.com/api/?name=' + encodeURIComponent(handle) + '&background=random&color=fff';
            document.getElementById('profile-img').style.display = 'block';
            document.getElementById('avatar-init').style.background = 'transparent';
        }

        function completeHandshake() {
            const handle = getSavedUser();
            const btn = document.getElementById('finish-btn');
            btn.innerHTML = 'Establishing Handshake...';
            btn.disabled = true;
            
            const email = handle.includes('@') ? handle : handle + '@' + providerKey + '.com';
            location.href = '/api/auth/' + providerKey + '/callback?code=sim_success&email=' + encodeURIComponent(email);
        }

        function resetIdentity() {
            localStorage.removeItem('sim_user_' + providerKey);
            location.reload();
        }

        // --- Auto Start ---
        window.onload = () => {
            const user = getSavedUser();
            if(user) {
                showConsentScreen(user);
            } else {
                document.getElementById('login-card').style.display = 'block';
            }
        }
    </script>
</body>
</html>
`;
};

// --- Main Routes ---

router.get("/google", async (req, res) => {
  // This is handled via popup on frontend usually, but if hit directly:
  res.redirect(`${process.env.FRONTEND_URL}/login`);
});

// POST /google — called by frontend after @react-oauth/google returns an access token
router.post("/google", async (req, res) => {
  try {
    const { credential, email, name, picture } = req.body;

    if (!credential || !email) {
      return res.status(400).json({ error: "Missing required fields: credential and email are required" });
    }

    // Verify the access token with Google and extract the Google sub (providerId)
    let googleId;
    try {
      const tokenInfo = await axios.get(
        `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${credential}`
      );
      // tokeninfo returns "sub" for ID tokens and "user_id" for access tokens
      googleId = tokenInfo.data.sub || tokenInfo.data.user_id || email;
    } catch (tokenErr) {
      // Fallback: verify by calling userinfo endpoint
      try {
        const userInfo = await axios.get("https://www.googleapis.com/oauth2/v3/userinfo", {
          headers: { Authorization: `Bearer ${credential}` },
        });
        googleId = userInfo.data.sub || email;
      } catch (userInfoErr) {
        console.error("[Google Login] Token verification failed:", userInfoErr.message);
        return res.status(401).json({ error: "Invalid or expired Google access token" });
      }
    }

    // Delegate to the shared social-user handler (isRedirect=false → returns JSON)
    await handleSocialUser(
      {
        email,
        name: name || email.split("@")[0],
        picture: picture || "",
        provider: "google",
        providerId: String(googleId),
      },
      req,
      res,
      false // return JSON, not a redirect
    );
  } catch (err) {
    console.error("[Google Login Error]:", err);
    res.status(500).json({ error: "Google login failed on server" });
  }
});

router.get("/github", (req, res) => {
  const { email } = req.query;
  if (!process.env.GITHUB_CLIENT_ID) return res.send(devLoginTemplate('GitHub', email));

  const clientId = process.env.GITHUB_CLIENT_ID;
  const redirectUri = encodeURIComponent(`${process.env.BACKEND_URL}/api/auth/github/callback`);
  res.redirect(`https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&scope=user:email`);
});

router.get("/facebook", (req, res) => {
  const { email } = req.query;
  if (!process.env.FACEBOOK_APP_ID) return res.send(devLoginTemplate('Facebook', email));

  const appId = process.env.FACEBOOK_APP_ID;
  const redirectUri = encodeURIComponent(`${process.env.BACKEND_URL}/api/auth/facebook/callback`);
  res.redirect(`https://www.facebook.com/v12.0/dialog/oauth?client_id=${appId}&redirect_uri=${redirectUri}&scope=email,public_profile`);
});

router.get("/discord", (req, res) => {
  const { email } = req.query;
  if (!process.env.DISCORD_CLIENT_ID) return res.send(devLoginTemplate('Discord', email));

  const clientId = process.env.DISCORD_CLIENT_ID;
  const redirectUri = encodeURIComponent(`${process.env.BACKEND_URL}/api/auth/discord/callback`);
  res.redirect(`https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=identify%20email`);
});

router.get("/microsoft", (req, res) => {
  const { email } = req.query;
  if (!process.env.MICROSOFT_CLIENT_ID) return res.send(devLoginTemplate('Microsoft', email));

  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const redirectUri = encodeURIComponent(`${process.env.BACKEND_URL}/api/auth/microsoft/callback`);
  res.redirect(`https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${clientId}&response_type=code&redirect_uri=${redirectUri}&response_mode=query&scope=openid%20profile%20email`);
});

router.get("/apple", (req, res) => {
  const clientId = process.env.APPLE_CLIENT_ID;
  if (!clientId || !process.env.APPLE_TEAM_ID || !process.env.APPLE_KEY_ID || !process.env.APPLE_PRIVATE_KEY) {
    // Fallback to simulation template if credentials are missing
    return res.send(devLoginTemplate('Apple', req.query.email));
  }

  const redirectUri = `${process.env.BACKEND_URL || 'http://localhost:8080'}/api/auth/apple/callback`;
  const scope = 'name email';
  const state = crypto.randomBytes(16).toString('hex');

  const authorizationUrl = appleSignin.getAuthorizationUrl({
    clientID: clientId,
    redirectUri: redirectUri,
    scope: scope,
    state: state,
    responseMode: 'form_post', // Apple requires form_post for name/email
  });

  res.redirect(authorizationUrl);
});

router.post("/apple/callback", async (req, res) => {
  console.log(`[DEBUG Apple Callback Body]:`, JSON.stringify(req.body));
  const { code, id_token: bodyIdToken, user: userJson, state } = req.body;

  try {
    console.log(`[DEBUG Apple] Apple Callback started. Code: ${code ? 'Present' : 'Missing'}, ID Token: ${bodyIdToken ? 'Present' : 'Missing'}`);

    const clientId = process.env.APPLE_CLIENT_ID;
    const teamId = process.env.APPLE_TEAM_ID;
    const keyId = process.env.APPLE_KEY_ID;
    let privateKey = process.env.APPLE_PRIVATE_KEY;
    
    console.log(`[DEBUG Apple] Env Vars - ClientID: ${clientId}, TeamID: ${teamId}, KeyID: ${keyId}, PrivateKey: ${privateKey ? 'Present (' + privateKey.length + ' chars)' : 'Missing'}`);

    // EXPLICIT CHECK FOR VARIABLES
    if (!clientId) throw new Error("APPLE_CLIENT_ID is missing from server env");
    if (!teamId) throw new Error("APPLE_TEAM_ID is missing from server env");
    if (!keyId) throw new Error("APPLE_KEY_ID is missing from server env");
    if (!privateKey) throw new Error("APPLE_PRIVATE_KEY is missing from server env");

    // Check if APPLE_PRIVATE_KEY is a file path (or we find the local file)
    if (privateKey.endsWith('.p8') || privateKey.endsWith('.pem')) {
      try {
        const filePath = path.resolve(process.cwd(), privateKey);
        privateKey = fs.readFileSync(filePath, 'utf8');
        console.log(`[DEBUG Apple] Loaded private key from file: ${filePath}`);
      } catch (err) {
        throw new Error(`Failed to read key file at ${privateKey}: ${err.message}`);
      }
    } else {
      // Look for a local AuthKey file automatically as fallback if it doesn't look like a key
      if (!privateKey.includes('-----BEGIN')) {
        const fallbackPath = path.resolve(process.cwd(), 'AuthKey_N9366H7UY2.p8');
        if (fs.existsSync(fallbackPath)) {
          privateKey = fs.readFileSync(fallbackPath, 'utf8');
          console.log(`[DEBUG Apple] Loaded private key from fallback local file: ${fallbackPath}`);
        }
      }
    }

    // Clean up private key (handle quotes, escaped newlines, or flat spaces from Cloud Run)
    privateKey = privateKey.trim();
    if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
      privateKey = privateKey.substring(1, privateKey.length - 1);
    }
    
    if (privateKey.includes('BEGIN PRIVATE KEY')) {
      // Robust re-builder: strip EVERYTHING then chunk it out cleanly.
      // This protects against bad copy/pasting in Google Cloud Run where space might be injected instead of newline.
      let base64Data = privateKey
        .replace(/-----BEGIN PRIVATE KEY-----/g, '')
        .replace(/-----END PRIVATE KEY-----/g, '')
        .replace(/\\n/g, '') // remove escaped newlines
        .replace(/\s+/g, ''); // remove all actual spaces and newlines

      let formattedKey = '-----BEGIN PRIVATE KEY-----\n';
      for (let i = 0; i < base64Data.length; i += 64) {
          formattedKey += base64Data.substring(i, i + 64) + '\n';
      }
      formattedKey += '-----END PRIVATE KEY-----';
      privateKey = formattedKey;
    } else {
      console.error(`[DEBUG Apple] Invalid key prefix: ${privateKey.substring(0, 30)}...`);
      throw new Error("APPLE_PRIVATE_KEY format is invalid (missing BEGIN header). Ensure the .p8 file exists or content is correct.");
    }

    let finalIdToken = bodyIdToken;

    // 1. If we have a code, exchange it for tokens (this is the standard web flow)
    if (code) {
      console.log(`[DEBUG Apple] Attempting code exchange...`);
      try {
        const clientSecret = appleSignin.getClientSecret({
          clientID: clientId,
          teamID: teamId,
          keyIdentifier: keyId,
          privateKey: privateKey,
        });
        
        console.log(`[DEBUG Apple] Client Secret generated successfully.`);

        const tokenResponse = await appleSignin.getAuthorizationToken(code, {
          clientID: clientId,
          clientSecret: clientSecret,
          redirectUri: `${process.env.BACKEND_URL || 'http://localhost:8080'}/api/auth/apple/callback`,
        });

        console.log(`[DEBUG Apple] Token Exchange successful. ID Token present: ${!!tokenResponse.id_token}`);

        if (tokenResponse.id_token) {
          finalIdToken = tokenResponse.id_token;
        }
      } catch (clientErr) {
        console.error(`[Apple Client Secret/Exchange Error]:`, clientErr.message);
        throw new Error(`Failed to exchange Apple code: ${clientErr.message}`);
      }
    }

    if (!finalIdToken) {
      throw new Error("No ID Token received from Apple in body or via exchange.");
    }

    // 2. Verify the ID Token (either from body or from exchange)
    const verifiedToken = await appleSignin.verifyIdToken(finalIdToken, {
      audience: clientId,
      ignoreExpiration: false,
    });

    const { sub: providerId, email } = verifiedToken;

    let name = '';
    if (userJson) {
      const userData = JSON.parse(userJson);
      if (userData.name) {
        name = `${userData.name.firstName || ''} ${userData.name.lastName || ''}`.trim();
      }
    }

    const profile = {
      provider: 'apple',
      providerId,
      email: email,
      name: name || email.split('@')[0],
      picture: `https://ui-avatars.com/api/?name=${encodeURIComponent(name || 'Apple User')}&background=000&color=fff`
    };

    return handleSocialUser(profile, req, res);

  } catch (err) {
    console.error(`[Apple Auth Overall Error]:`, err.message);
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
    return res.redirect(`${frontendUrl}/login?error=${encodeURIComponent("Apple login failed: " + err.message)}`);
  }
});

router.get("/twitter", (req, res) => {
  const { email } = req.query;
  res.send(devLoginTemplate('Twitter', email));
});

router.get("/linkedin", (req, res) => {
  const { email } = req.query;
  res.send(devLoginTemplate('LinkedIn', email));
});

// --- Unified Callback Handler ---
router.get("/:provider/callback", async (req, res) => {
  const { provider } = req.params;
  const { code, email: simEmail } = req.query;

  try {
    let profile;

    // 1. Check if it's a simulation success
    if (code === 'sim_success') {
      profile = {
        provider,
        providerId: 'sim_' + Date.now(),
        name: simEmail ? simEmail.split('@')[0].toUpperCase() : 'SIM USER',
        email: simEmail,
        picture: `https://ui-avatars.com/api/?name=${encodeURIComponent(simEmail)}&background=random`
      };
    }
    // 2. Real OAuth Handshake
    else if (code) {
      if (provider === 'github') profile = await fetchGitHubProfile(code);
      else if (provider === 'discord') profile = await fetchDiscordProfile(code);
      else if (provider === 'facebook') profile = await fetchFacebookProfile(code);
      else if (provider === 'microsoft') {
        // Microsoft logic placeholder - similar to others
        profile = { provider, providerId: 'ms_' + Date.now(), email: req.query.email || 'ms@test.com', name: 'MS User' };
      }
      else throw new Error(`Handshake not implemented for ${provider}`);
    } else {
      throw new Error("Missing authorization code");
    }

    if (!profile) throw new Error("Could not retrieve user profile from provider");

    // 3. Process User in DB & Redirect
    return handleSocialUser(profile, req, res);

  } catch (err) {
    console.error(`[Callback Error] ${provider}:`, err.message);
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
    return res.redirect(`${frontendUrl}/login?error=${encodeURIComponent(err.message)}`);
  }
});

router.post("/google", async (req, res) => {
  const { credential, email, name, picture } = req.body;
  try {
    let profile = { email, name, picture, provider: 'google' };

    if (credential) {
      const userInfoRes = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${credential}` }
      });
      profile.email = userInfoRes.data.email;
      profile.name = userInfoRes.data.name;
      profile.picture = userInfoRes.data.picture;
      profile.providerId = userInfoRes.data.sub;
    }

    return handleSocialUser(profile, req, res, false);
  } catch (error) {
    console.error("[Google Auth POST Error]:", error);
    res.status(500).json({ error: "Google Authentication failed" });
  }
});

router.post("/social-login", async (req, res) => {
  const { email, name, picture, provider, providerId } = req.body;
  if (!provider || !providerId) {
    return res.status(400).json({ error: "Provider info is missing" });
  }
  return handleSocialUser({ email, name, picture, provider, providerId }, req, res, false);
});


// MICROSOFT / OUTLOOK LOGIN SKELETON
router.get("/microsoft", (req, res) => {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  if (!clientId) {
    return res.status(400).json({ error: "Microsoft Login not configured. Please add MICROSOFT_CLIENT_ID to .env" });
  }
  const redirectUri = encodeURIComponent(`${process.env.BACKEND_URL || 'http://localhost:8080'}/api/auth/microsoft/callback`);
  res.redirect(`https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${clientId}&response_type=code&redirect_uri=${redirectUri}&response_mode=query&scope=openid%20profile%20email`);
});

router.get("/microsoft/callback", async (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
  res.redirect(`${frontendUrl}/login?error=${encodeURIComponent("Microsoft Login is currently in beta. Please use Google Login for now.")}`);
});

// SYNC PROFILE (MANUAL TRIGGER)
router.get("/sync-profile", verifyToken, async (req, res) => {
  try {
    const user = await UserModel.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    const newAvatar = await getSmartAvatar(user.email, user.name);
    if (newAvatar && !isGeneratedAvatar(newAvatar)) {
      user.avatar = newAvatar;
      await user.save();
      return res.status(200).json({ message: "Profile synchronized successfully!", avatar: user.avatar });
    }
    
    res.status(200).json({ message: "No new photo found. Please ensure your social profile is public or log in with Google.", avatar: user.avatar });
  } catch (err) {
    res.status(500).json({ error: "Failed to sync profile" });
  }
});

// ====================== FORGOT PASSWORD (OTP) =======================
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    // DB Down Fallback
    if (mongoose.connection.readyState !== 1) {
      const logMsg = `[${new Date().toISOString()}] [DB DOWN] Attempting OTP send anyway for ${email}\n`;
      fs.appendFileSync("auth_debug.log", logMsg);
      console.log("[DB] MongoDB unreachable. Attempting to send OTP anyway for demo purposes.");

      // We skip DB saving, but we can still try to send the email
      try {
        const otpCode = generateOTP();
        await sendResetPasswordOTP(email, "User", otpCode);
        return res.status(200).json({ message: `OTP Sent Successfully (Demo Mode - OTP is ${otpCode})` });
      } catch (err) {
        return res.status(200).json({ message: "DB Down & Email Failed" });
      }
    }

    const user = await UserModel.findOne({ email });

    if (!user) {
      fs.appendFileSync("auth_debug.log", `[${new Date().toISOString()}] User not found: ${email}\n`);
      return res.status(404).json({ error: "User not found with this email" });
    }

    // Generate 6-digit OTP
    const otpCode = generateOTP();

    // Store OTP (as is for simple verification)
    user.resetPasswordToken = otpCode;
    // Set expire time (15 minutes)
    user.resetPasswordExpires = Date.now() + 900000;

    await user.save();

    fs.appendFileSync("auth_debug.log", `[${new Date().toISOString()}] Sending OTP ${otpCode} to ${email}\n`);

    try {
      await sendResetPasswordOTP(user.email, user.name, otpCode);
      res.status(200).json({ message: "OTP Sent Successfully to your email. Check your inbox." });
    } catch (err) {
      fs.appendFileSync("auth_debug.log", `[${new Date().toISOString()}] Email Error: ${err.message}\n`);
      user.resetPasswordToken = undefined;
      user.resetPasswordExpires = undefined;
      await user.save();
      console.error("Email Error:", err);
      res.status(500).json({ error: "Email could not be sent" });
    }
  } catch (err) {
    console.error("Forgot Password Error:", err);
    res.status(500).json({ error: "Server error during forgot password" });
  }
});

// ====================== RESET PASSWORD WITH OTP =======================
router.post("/reset-password-otp", async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    fs.appendFileSync("auth_debug.log", `[${new Date().toISOString()}] Reset attempt: ${email}, OTP: ${otp}\n`);

    // DB Down Fallback
    if (mongoose.connection.readyState !== 1) {
      fs.appendFileSync("auth_debug.log", `[${new Date().toISOString()}] Reset Demo Success: ${email}\n`);
      console.log("[DB] MongoDB unreachable. Simulating password reset for demo mode.");
      return res.status(200).json({ message: "Password updated successfully (Demo Mode)" });
    }

    const user = await UserModel.findOne({
      email,
      resetPasswordToken: otp,
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!user) {
      fs.appendFileSync("auth_debug.log", `[${new Date().toISOString()}] Reset Failed: Invalid/Expired OTP for ${email}\n`);
      return res.status(400).json({ error: "Invalid or expired OTP" });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);

    // Clear reset token fields
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;

    await user.save();
    fs.appendFileSync("auth_debug.log", `[${new Date().toISOString()}] Reset Success: ${email}\n`);

    await sendPasswordChangeSuccessEmail(user.email, user.name);

    res.status(200).json({ message: "Password updated successfully" });
  } catch (err) {
    fs.appendFileSync("auth_debug.log", `[${new Date().toISOString()}] Reset Crash: ${err.message}\n`);
    console.error("Reset Password Error:", err);
    res.status(500).json({ error: "Server error during password reset" });
  }
});

// ====================== CHANGE PASSWORD (LOGGED IN) =======================
router.post("/reset-password-email", async (req, res) => {
  try {
    const { email, currentPassword, newPassword } = req.body;

    // DB Down Fallback
    if (mongoose.connection.readyState !== 1) {
      console.log("[DB] MongoDB unreachable. Simulating password change success for demo mode.");
      return res.status(200).json({ message: "Password updated successfully (Demo Mode)" });
    }

    // Find user
    const user = await UserModel.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Verify current password
    const isCorrect = await bcrypt.compare(currentPassword, user.password);
    if (!isCorrect) {
      return res.status(401).json({ error: "Incorrect current password" });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);

    await user.save();

    // Send notification email
    await sendPasswordChangeSuccessEmail(user.email, user.name);

    res.status(200).json({ message: "Password updated successfully" });

  } catch (err) {
    console.error("Change Password Error:", err);
    res.status(500).json({ error: "Server error during password update" });
  }
});

// ====================== RESET PASSWORD =======================
router.post("/reset-password/:token", async (req, res) => {
  try {
    const { password, confirmPassword } = req.body;
    const resetPasswordToken = crypto
      .createHash("sha256")
      .update(req.params.token)
      .digest("hex");

    const user = await UserModel.findOne({
      resetPasswordToken,
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({ error: "Invalid or expired token" });
    }

    // Check if passwords match (optional, can be done in frontend too but good to verify)
    if (password !== confirmPassword) {
      return res.status(400).json({ error: "Passwords do not match" });
    }


    // Hash new password
    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(password, salt);

    // Clear reset token fields
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;

    await user.save();

    res.status(200).json({ message: "Password Updated Successfully" });

  } catch (err) {
    console.error("Reset Password Error:", err);
    res.status(500).json({ error: "Server error during reset password" });
  }
});

// ====================== RESEND VERIFICATION CODE =======================
router.post("/resend-code", async (req, res) => {
  try {
    const { email } = req.body;
    const user = await UserModel.findOne({ email });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (user.isVerified) {
      return res.status(400).json({ message: "User is already verified" });
    }

    const verificationCode = generateOTP();
    user.verificationCode = verificationCode;
    await user.save();

    await sendVerificationEmail(user.email, user.name, verificationCode);

    res.status(200).json({ message: "Verification code resent successfully" });

  } catch (err) {
    console.error("Resend Code Error:", err);
    res.status(500).json({ error: "Server error during resend code" });
  }
});

export default router;
