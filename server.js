require("dotenv").config();

const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");
const cors = require("cors");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

/* ================= MongoDB ================= */
mongoose.connect(process.env.MONGO_URL)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.log("❌ MongoDB error", err));

const userSchema = new mongoose.Schema({
  username: String,
  password: String,
  role: String
});

const User = mongoose.model("User", userSchema);

/* ================= OTP STORE ================= */
const otpStore = {};

/* ================= EMAIL ================= */
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

/* ================= AUTH ================= */

// SIGNUP
app.post("/api/signup", async (req, res) => {
  const { username, password, role } = req.body;

  if (await User.findOne({ username })) {
    return res.status(400).json({ message: "User already exists" });
  }

  const hashed = await bcrypt.hash(password, 10);
  await User.create({ username, password: hashed, role });

  res.json({ message: "Signup successful" });
});

// SIGNIN + AUTO OTP
app.post("/api/signin", async (req, res) => {
  const { username, password } = req.body;

  const user = await User.findOne({ username });
  if (!user) {
    return res.status(401).json({ message: "User not found" });
  }

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) {
    const otp = Math.floor(100000 + Math.random() * 900000);
    otpStore[username] = otp;

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: username,
      subject: "Bus Tracking OTP",
      text: `Your OTP is ${otp}`
    });

    return res.status(401).json({
      message: "Wrong password. OTP sent to your email."
    });
  }

  res.json({ role: user.role });
});

// RESET PASSWORD
app.post("/api/reset-password", async (req, res) => {
  const { username, otp, newPassword } = req.body;

  if (otpStore[username] != otp) {
    return res.status(400).json({ message: "Invalid OTP" });
  }

  const hashed = await bcrypt.hash(newPassword, 10);
  await User.updateOne({ username }, { password: hashed });

  delete otpStore[username];
  res.json({ message: "Password reset successful" });
});

// ADMIN CHECK
app.post("/api/check-admin", async (req, res) => {
  const user = await User.findOne({ username: req.body.username });
  if (user && user.role === "admin") res.json({ ok: true });
  else res.status(403).json({ ok: false });
});

/* ================= BUS TRACKING ================= */
const buses = {};

io.on("connection", socket => {
  socket.on("updateLocation", data => {
    buses[data.id] = { lat: data.lat, lon: data.lon };
    io.emit("fleetUpdate", buses);
  });
});

/* ================= START ================= */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("🚀 Server running on", PORT);
});
