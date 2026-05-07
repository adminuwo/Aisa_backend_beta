import { v4 as uuidv4 } from 'uuid';
import Guest from '../models/Guest.js';

export const identifyGuest = async (req, res, next) => {
    // If authenticated as user, guest logic is not needed for limits (but session might need it)
    if (req.user) return next();

    let guestId = req.cookies.aisa_guest_id;
    const fingerprint = req.headers['x-device-fingerprint'];
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    try {
        let guest;

        // 1. Check by guestId cookie
        if (guestId && guestId !== 'undefined' && guestId !== 'null') {
            guest = await Guest.findOne({ guestId });
        }

        // 2. Fallback to fingerprint (DISABLED: Fingerprints are not unique enough and cause collisions)
        /*
        if (!guest && fingerprint) {
            guest = await Guest.findOne({ fingerprint });
            if (guest) guestId = guest.guestId;
        }
        */

        // 3. Fallback to IP (LESS STRICT for session sharing prevention, prefer cookie/fingerprint)
        // If we only have IP, we should be careful. 
        // BETTER: If no cookie/fingerprint, treat as NEW user, do not link by IP alone to avoid "shared office" issues.
        // We will only use IP for rate limiting, not identity.

        /* 
        if (!guest && ip) {
            guest = await Guest.findOne({ ip });
            if (guest) guestId = guest.guestId;
        } 
        */

        // 4. Create new guest if none found
        if (!guest) {
            // New Guest ID
            guestId = `guest_${uuidv4()}`;
            guest = new Guest({
                guestId: guestId,
                fingerprint: fingerprint ? `${fingerprint}_${uuidv4()}` : `fp_${uuidv4()}`, // Ensure uniqueness
                ip: ip,
                sessionIds: []
            });
            await guest.save();
            console.log('[GUEST] Generated new unique guest identity:', guestId);
        } else {
            // Update fingerprint/IP if found
            let updated = false;
            // Only update fingerprint if it was missing before, don't overwrite
            if (fingerprint && !guest.fingerprint) {
                guest.fingerprint = fingerprint;
                updated = true;
            }
            // Always update last known IP
            if (ip && guest.ip !== ip) {
                guest.ip = ip;
                updated = true;
            }
            if (updated) await guest.save();
        }

        // Set HttpOnly cookie
        const isProduction = process.env.NODE_ENV === 'production' || req.hostname !== 'localhost';
        res.cookie('aisa_guest_id', guestId, {
            httpOnly: true,
            secure: isProduction, // Only secure in production or non-localhost
            sameSite: isProduction ? 'none' : 'lax', // Use 'lax' for local dev to avoid CSRF issues while allowing cookies
            maxAge: 365 * 24 * 60 * 60 * 1000 // 1 year
        });

        req.guest = guest;
        next();
    } catch (error) {
        console.error('[GUEST MIDDLEWARE ERROR]', error);
        next();
    }
};
