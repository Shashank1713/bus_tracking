require("dotenv").config();
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

app.use(express.json());
app.use(express.static("public"));

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false
}));

mongoose.connect(process.env.MONGO_URL)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.log("❌ MongoDB error", err));

/* ---------- EMAIL ---------- */
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

/* ---------- SIGNUP ---------- */
app.post("/api/signup", async (req, res) => {
  const { email, password } = req.body;

  if (password.length < 6 || !/[!@#$%^&*]/.test(password)) {
    return res.status(400).json({ error: "Weak password" });
  }

  const hashed = await bcrypt.hash(password, 10);
  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  try {
    await User.create({
      email,
      password: hashed,
      otp,
      otpExpires: Date.now() + 5 * 60 * 1000
    });

    await transporter.sendMail({
      to: email,
      subject: "Bus Tracking OTP",
      text: `Your OTP is ${otp}`
    });

    res.json({ message: "OTP sent" });
  } catch {
    res.status(400).json({ error: "User already exists" });
  }
});

/* ---------- VERIFY OTP ---------- */
app.post("/api/verify-otp", async (req, res) => {
  const { email, otp } = req.body;
  const user = await User.findOne({ email });

  if (!user || user.otp !== otp || user.otpExpires < Date.now()) {
    return res.status(400).json({ error: "Invalid or expired OTP" });
  }

  user.isVerified = true;
  user.otp = null;
  user.otpExpires = null;
  await user.save();

  res.json({ success: true });
});

/* ---------- LOGIN (FIXED) ---------- */
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email });
  if (!user) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const match = await bcrypt.compare(password, user.password);
  if (!match) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  if (!user.isVerified) {
    return res.status(403).json({ error: "Email not verified" });
  }

  req.session.user = { id: user._id, role: user.role };
  res.json({ success: true });
});

/* ---------- LOGOUT ---------- */
app.get("/api/logout", (req, res) => {
  req.session.destroy(() => res.sendStatus(200));
});

/* ---------- SOCKET.IO (BUS TRACKING) ---------- */
const buses = {};

io.on("connection", socket => {
  socket.on("driverLocation", data => {
    buses[data.busId] = data;
    io.emit("fleetUpdate", buses);
  });

  socket.on("stopSharing", ({ busId }) => {
    delete buses[busId];
    io.emit("busStopped", busId);
  });
});

/* ---------- START ---------- */
server.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Server running");
});
