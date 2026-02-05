require("dotenv").config({ quiet: true });

const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const session = require("express-session");
const nodemailer = require("nodemailer");
const http = require("http");
const { Server } = require("socket.io");
const User = require("./models/User");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

/* ---------------- MIDDLEWARE ---------------- */

app.use(express.json());
app.use(express.static("public"));

app.use(session({
  secret: process.env.SESSION_SECRET || "bus_tracking_secret",
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // set true only with HTTPS
}));

/* ---------------- DATABASE ---------------- */

mongoose.connect(process.env.MONGO_URL)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.log("❌ MongoDB error", err));

/* ---------------- MAIL ---------------- */

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

async function sendOTP(email, otp, subject = "Bus Tracking OTP") {
  await transporter.sendMail({
    to: email,
    subject,
    html: `<h2>Your OTP</h2><h1>${otp}</h1><p>Valid for 5 minutes</p>`
  });
}

/* ---------------- AUTH ---------------- */

// SIGNUP
app.post("/api/signup", async (req, res) => {
  const { email, password } = req.body;

  if (!password || password.length < 6 || !/[!@#$%^&*]/.test(password))
    return res.status(400).json({ error: "Password must be 6+ chars & contain special character" });

  let user = await User.findOne({ email });

  // 🔁 User exists but not verified → resend OTP
  if (user && !user.isVerified) {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.otp = otp;
    user.otpExpires = Date.now() + 5 * 60 * 1000;
    await user.save();
    await sendOTP(email, otp, "Verify your email");
    return res.json({ message: "OTP resent to email" });
  }

  // ❌ User exists & verified
  if (user && user.isVerified) {
    return res.status(400).json({ error: "User already exists" });
  }

  // ✅ New user
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  user = await User.create({
    email,
    password: await bcrypt.hash(password, 10),
    otp,
    otpExpires: Date.now() + 5 * 60 * 1000,
    isVerified: false
  });

  await sendOTP(email, otp, "Verify your email");
  res.json({ message: "OTP sent to Gmail" });
});

// RESEND OTP
app.post("/api/resend-otp", async (req, res) => {
  const { email } = req.body;
  const user = await User.findOne({ email });

  if (!user || user.isVerified)
    return res.status(400).json({ error: "Invalid request" });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  user.otp = otp;
  user.otpExpires = Date.now() + 5 * 60 * 1000;
  await user.save();

  await sendOTP(email, otp, "Resend OTP");
  res.json({ message: "OTP resent" });
});

// VERIFY OTP
app.post("/api/verify-otp", async (req, res) => {
  const { email, otp } = req.body;
  const user = await User.findOne({ email });

  if (!user || user.otp !== otp || user.otpExpires < Date.now())
    return res.status(400).json({ error: "Invalid or expired OTP" });

  user.isVerified = true;
  user.otp = null;
  user.otpExpires = null;
  await user.save();

  res.json({ success: true });
});

// LOGIN
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });

  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  if (!user.isVerified)
    return res.status(403).json({ error: "Email not verified" });

  req.session.user = { id: user._id, role: user.role };
  res.json({ success: true });
});

// FORGOT PASSWORD
app.post("/api/forgot-password", async (req, res) => {
  const { email } = req.body;
  const user = await User.findOne({ email });

  if (!user) return res.status(404).json({ error: "User not found" });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  user.otp = otp;
  user.otpExpires = Date.now() + 5 * 60 * 1000;
  await user.save();

  await sendOTP(email, otp, "Reset Password OTP");
  res.json({ message: "OTP sent" });
});

// RESET PASSWORD
app.post("/api/reset-password", async (req, res) => {
  const { email, otp, newPassword } = req.body;

  if (!newPassword || newPassword.length < 6 || !/[!@#$%^&*]/.test(newPassword))
    return res.status(400).json({ error: "Weak password" });

  const user = await User.findOne({ email });
  if (!user || user.otp !== otp || user.otpExpires < Date.now())
    return res.status(400).json({ error: "Invalid OTP" });

  user.password = await bcrypt.hash(newPassword, 10);
  user.otp = null;
  user.otpExpires = null;
  await user.save();

  res.json({ message: "Password reset successful" });
});

/* ---------------- SOCKET.IO ---------------- */

const buses = {};

io.on("connection", socket => {
  socket.on("driverLocation", ({ busId, lat, lon }) => {
    buses[busId] = { busId, lat, lon, updatedAt: Date.now() };
    io.emit("fleetUpdate", buses);
  });

  socket.on("stopSharing", ({ busId }) => {
    delete buses[busId];
    io.emit("fleetUpdate", buses);
  });
});

/* ---------------- START SERVER ---------------- */

server.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Server running");
});
