import express, { urlencoded } from "express";
import dotenv from "dotenv";
import 'dotenv/config';
import cors from "cors";
import connectDB from "./config/db.js";
import chatRoutes from "./routes/chatRoutes.js";
import dashboardRoutes from "./routes/dashboardRoutes.js";
import agentRoutes from "./routes/agentRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import cookieParser from "cookie-parser";
import emailVerification from "./routes/emailVerification.js"
import userRoute from './routes/user.js'
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import * as stockService from './services/stockService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import chatRoute from './routes/chat.routes.js';
import knowledgeRoute from './routes/knowledge.routes.js';
// import aibaseRoutes from './routes/aibaseRoutes.js'; // Removed
// import * as aibaseService from './services/aibaseService.js'; // Removed

import notificationRoutes from "./routes/notificationRoutes.js";
import supportRoutes from './routes/supportRoutes.js';
import personalTaskRoutes from './routes/personalTaskRoutes.js';
import feedbackRoutes from './routes/feedbackRoutes.js';
import voiceRoutes from './routes/voiceRoutes.js';
import reminderRoutes from './routes/reminderRoutes.js';
import imageRoutes from './routes/image.routes.js';
import videoRoutes from './routes/videoRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import projectRoutes from './routes/projectRoutes.js';
import memoryRoutes from './routes/memoryRoutes.js';
import pricingRoutes from './routes/pricingRoutes.js';
import subscriptionRoutes from './routes/subscriptionRoutes.js';
import paymentRoutes from './routes/paymentRoutes.js';
import dataRoutes from './routes/dataRoutes.js';
import magicEditRoutes from './routes/magicEdit.routes.js';
import legalRoutes from './routes/legalRoutes.js';
import intentRoutes from './routes/intentRoutes.js';
import cashflowRoutes from './routes/cashflowRoutes.js';
import stockRoutes from './routes/stockRoutes.js';
import legalToolkitRoutes from './routes/legalToolkitRoutes.js';
import storageRoutes from './routes/storage.routes.js';
// import { startPlanExpiryService } from './services/planExpiryService.js';

// End of standard imports

dotenv.config();
const app = express();
const PORT = process.env.PORT || 8080;



// Connect to Database
connectDB().then(async () => {
  console.log("Database connection attempt finished, initializing services...");
  try {
    const { initializeConfigs } = await import('./services/configService.js');
    await initializeConfigs();

    const { initializeFromDB } = await import('./services/ai.service.js');
    await initializeFromDB();
    console.log("✅ AI Services (Embeddings & Vector Store) pre-initialized.");

    // Initialize Automatic Knowledge Update System (Crawler Scheduler)
    const { initScheduler } = await import('./services/scheduler.service.js');
    initScheduler();

    // Initialize Multi Schedule Reminder System
    const { initReminderScheduler } = await import('./services/reminderScheduler.js');
    initReminderScheduler();

  } catch (err) {
    console.error("❌ Failed to pre-initialize AI services:", err.message);
  }
}).catch(error => {
  console.error("Database connection failed during startup:", error);
});


// Middleware

app.use(cors({
  origin: true, // Allow any origin in development
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-device-fingerprint'],
  exposedHeaders: ['Content-Type', 'Authorization']
}));
app.use(cookieParser())
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
// app.use(fileUpload()); // Removed to avoid conflict with Multer (New AIBASE)

app.get("/ping-top", (req, res) => {
  res.send("Top ping works");
})

// Serve static frontend files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// API Health Check (moved from root)
app.get("/api/health", (req, res) => {
  res.send("All working")
})
// Global Debug middleware
app.use((req, res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.url}`);
  next();
});

// --- API Routes Registration ---

// Auth & User
app.use('/api/auth/verify-email', emailVerification);
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoute);
app.use('/api/user', dataRoutes);  // GDPR data deletion & export
app.use('/api/legal', legalRoutes);
app.use('/api/legal-toolkit', legalToolkitRoutes);

// Intelligence Features
app.use('/api/chat', chatRoutes);
app.use('/api/agents', agentRoutes);
app.use('/api/voice', voiceRoutes);
app.use('/api/image', imageRoutes);
app.use('/api/edit-image', magicEditRoutes);
app.use('/api/video', videoRoutes);

// Intent Routing & Orchestration System
app.use('/api/intent', intentRoutes);
app.use('/api/cashflow', cashflowRoutes);
app.use('/api/stock', stockRoutes);

// Utility & Support
app.use('/api/notifications', notificationRoutes);
app.use('/api/reminders', reminderRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/personal-assistant', personalTaskRoutes);
app.use('/api/memory', memoryRoutes);

// Business & Dashboard
app.use('/api/pricing', pricingRoutes);
app.use('/api/subscription', subscriptionRoutes);
app.use('/api/payment', paymentRoutes);
app.get('/api/debug-payment', (req, res) => res.json({ msg: "payment route check" }));
app.use('/api/dashboard', dashboardRoutes);

// Admin Panel (Admin only)
app.use('/api/admin', adminRoutes);

// Storage Proxy (for private GCS assets)
app.use('/api/storage', storageRoutes);

// Projects
app.use('/api/projects', projectRoutes);


// AIBASE (V3) - With Credit System
const { verifyToken } = await import('./middleware/authorization.js');
const { creditMiddleware } = await import('./middleware/creditSystem.js');

app.use('/api/aibase/chat', verifyToken, creditMiddleware, chatRoute);
app.use('/api/aibase/knowledge', verifyToken, creditMiddleware, knowledgeRoute);

// --- End of Routes ---

// SPA Catch-all to serve index.html for unknown non-API routes
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  next();
});

// Catch-all 404 for API routes
app.use((req, res) => {
  console.warn(`[404 NOT MATCHED] ${req.method} ${req.originalUrl}`);
  res.status(404).json({
    error: "Route not found",
    method: req.method,
    path: req.originalUrl
  });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error("[SERVER ERROR]", err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});

// Start listening
const server = app.listen(PORT, () => {
  console.log(`AISA Backend running on http://localhost:${PORT}`);
});

// --- WebSockets for Market Data ---
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const activeRealtimeSubscriptions = new Map(); // socket.id -> { symbol, intervalId }

io.on('connection', (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);

  // Handle Realtime Subscription
  socket.on('subscribe_realtime', async ({ symbol }) => {
    console.log(`[Socket] ${socket.id} subscribed to realtime: ${symbol}`);
    
    // Clear previous subscription if it exists
    if (activeRealtimeSubscriptions.has(socket.id)) {
        clearInterval(activeRealtimeSubscriptions.get(socket.id).intervalId);
    }

    // Immediately fetch and emit once
    try {
        const initialData = await stockService.getQuote(symbol);
        socket.emit('realtime_update', { quote: initialData });
    } catch (err) {}

    // Simulated websocket streaming (polling backend API)
    const intervalId = setInterval(async () => {
        try {
            const data = await stockService.getQuote(symbol);
            if (data) {
                // Sent exact price without any artificial jitter
                socket.emit('realtime_update', { quote: data });
            }
        } catch (error) {
            console.error(`[Socket] Live fetch error for ${symbol}:`, error.message);
        }
    }, 2000); // 2-second ticks over WebSocket

    activeRealtimeSubscriptions.set(socket.id, { symbol, intervalId });
  });

  // Handle Historical Request
  socket.on('request_historical', async ({ symbol }) => {
    console.log(`[Socket] ${socket.id} requested historical data for: ${symbol}`);
    try {
        const historical = await stockService.getHistorical(symbol);
        socket.emit('historical_data_response', { historical });
    } catch (error) {
        socket.emit('historical_data_response', { error: 'Failed to fetch historical data' });
    }
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] Client disconnected: ${socket.id}`);
    if (activeRealtimeSubscriptions.has(socket.id)) {
        clearInterval(activeRealtimeSubscriptions.get(socket.id).intervalId);
        activeRealtimeSubscriptions.delete(socket.id);
    }
  });
});

server.timeout = 900000; // 15 mins


// Keep process alive for local development
setInterval(() => { }, 1000 * 60 * 60); // Keep alive process
// trigger restart
