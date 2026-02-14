require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const session = require("express-session");
const http = require("http");
const { Server } = require("socket.io");

const User = require("./models/User");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ---------------- MIDDLEWARE ----------------
app.use(express.json());
app.use(express.static("public"));

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false
  })
);

// ---------------- DB ----------------
mongoose
  .connect(process.env.MONGO_URL)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.log("❌ MongoDB error", err));

// ---------------- ROOT ----------------
app.get("/", (req, res) => {
  res.redirect("/login.html");
});

// ---------------- SESSION CHECK ----------------
app.get("/api/session-check", (req, res) => {
  if (req.session.userId) return res.sendStatus(200);
  res.sendStatus(401);
});

// ---------------- SEND OTP (DEMO MODE) ----------------
app.post("/api/send-otp", async (req, res) => {
  let { mobile } = req.body;

  const mobileRegex = /^(\+91)?[6-9]\d{9}$/;
  if (!mobileRegex.test(mobile)) {
    return res.status(400).json({ error: "Invalid mobile number" });
  }

  if (!mobile.startsWith("+91")) {
    mobile = "+91" + mobile;
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  let user = await User.findOne({ mobile });
  if (!user) user = new User({ mobile });

  user.otp = otp;
  user.otpExpires = Date.now() + 5 * 60 * 1000;
  user.isVerified = false;
  await user.save();

  // 🔥 DEMO OTP (NO SMS)
  console.log("✅ DEMO OTP:", otp, "for", mobile);

  res.json({ message: "OTP sent successfully (demo)" });
});

// ---------------- VERIFY OTP ----------------
app.post("/api/verify-otp", async (req, res) => {
  let { mobile, otp } = req.body;

  if (!mobile.startsWith("+91")) {
    mobile = "+91" + mobile;
  }

  const user = await User.findOne({ mobile });

  if (
    !user ||
    user.otp !== otp ||
    !user.otpExpires ||
    user.otpExpires < Date.now()
  ) {
    return res.status(400).json({ error: "Invalid or expired OTP" });
  }

  user.isVerified = true;
  user.otp = null;
  user.otpExpires = null;
  await user.save();

  req.session.userId = user._id;

  res.json({ redirect: "/auth.html" });
});

// ---------------- LOGOUT ----------------
app.get("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// ---------------- SOCKET BUS TRACKING ----------------
const buses = {};

io.on("connection", socket => {
  socket.on("driverLocation", ({ busId, lat, lon }) => {
    buses[busId] = { lat, lon, updatedAt: Date.now() };
    io.emit("fleetUpdate", buses);
  });

  socket.on("stopSharing", ({ busId }) => {
    delete buses[busId];
    io.emit("fleetUpdate", buses);
  });
});

// ---------------- START ----------------
server.listen(process.env.PORT, () => {
  console.log(`🚀 Server running on port ${process.env.PORT}`);
});
