import express from "express"
import userModel from "../models/User.js"
import { welcomeEmail } from "../utils/Email.js"
import generateTokenAndSetCookies from "../utils/generateTokenAndSetCookies.js"
const router = express.Router()


router.post("/", async (req, res) => {
    try {
        const { code, email } = req.body;
        const user = await userModel.findOne({ email });

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        if (user.verificationCode === code) {
            user.isVerified = true;
            user.verificationCode = undefined;
            await user.save();

            const token = generateTokenAndSetCookies(res, user._id, email, user.name);

            // Send welcome email asynchronously
            welcomeEmail(user.name, user.email).catch(err => console.error("Welcome email error:", err));

            return res.status(200).json({
                id: user._id,
                name: user.name,
                email: user.email,
                message: "Email verified successfully",
                token,
            });
        } else {
            return res.status(400).json({ error: "Invalid verification code" });
        }
    } catch (err) {
        console.error("Verification Error:", err);
        return res.status(500).json({ error: "Server error during verification" });
    }
});
export default router
