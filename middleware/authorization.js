import jwt from "jsonwebtoken";
import Session from "../models/Session.js";
import mongoose from "mongoose";

export const verifyToken = async (req, res, next) => {
    let token = null;
    
    if (req.headers.authorization) {
        token = req.headers.authorization.split(" ")[1];
    } else if (req.query.token) {
        token = req.query.token;
    } else if (req.cookies?.token) {
        token = req.cookies.token;
    }

    if (!token || token === 'undefined' || token === 'null') {
        return res.status(401).json({ error: "No token provided" });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // --- NEW: Session Validation ---
        // Check if the session still exists in the database
        // Only skip check if DB is down or it's a demo/admin token
        if (mongoose.connection.readyState === 1 && !decoded.id.startsWith?.('demo-')) {
            const sessionExists = await Session.findOne({ userId: decoded.id, token });
            if (!sessionExists) {
                console.warn(`[AUTH] Blocked request for revoked session. User: ${decoded.email}`);
                return res.status(401).json({ 
                    error: "Session revoked", 
                    code: "SESSION_REVOKED",
                    message: "This device has been logged out remotely." 
                });
            }

            // Update last active time silently
            Session.updateOne({ _id: sessionExists._id }, { lastActive: Date.now() }).catch(err => {});
        }

        req.user = decoded;
        next();
    } catch (error) {
        console.error(`[AUTH ERROR] JWT Verification Failed: ${error.message}`);
        return res.status(401).json({ error: "Invalid or expired token" });
    }
};

export const optionalVerifyToken = (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
        req.user = null;
        return next();
    }

    const token = authHeader.split(" ")[1];

    if (!token || token === 'undefined' || token === 'null') {
        req.user = null;
        return next();
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
    } catch (error) {
        // Token present but invalid/expired - treat as guest
        req.user = null;
    }
    next();
};
