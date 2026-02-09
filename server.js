require("dotenv").config({ quiet: true });

const express = require("express");
const mongoose = require("mongoose");
const session = require("express-session");
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

// ROOT FIX (IMPORTANT FOR RENDER)
app.get("/", (req, res) => {
  res.redirect("/login.html");
});

// MONGODB
mongoose.connect(process.env.MONGO_URL)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.log("❌ MongoDB error", err));

/* ---------- MOBILE OTP AUTH ---------- */

// SEND OTP
app.post("/api/send-otp", async (req, res) => {
  const { mobile } = req.body;

  if (!/^[6-9]\d{9}$/.test(mobile))
    return res.status(400).json({ error: "Invalid mobile number" });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  let user = await User.findOne({ mobile });
  if (!user) user = await User.create({ mobile });

  user.otp = otp;
  user.otpExpires = Date.now() + 5 * 60 * 1000;
  await user.save();

  // DEMO MODE (OTP IN CONSOLE)
  console.log(`📱 OTP for ${mobile}: ${otp}`);

  res.json({ message: "OTP sent to mobile" });
});

// VERIFY OTP
app.post("/api/verify-otp", async (req, res) => {
  const { mobile, otp } = req.body;

  const user = await User.findOne({ mobile });

  if (!user || user.otp !== otp || user.otpExpires < Date.now())
    return res.status(400).json({ error: "Invalid OTP" });

  user.isVerified = true;
  user.otp = null;
  user.otpExpires = null;
  await user.save();

  req.session.userId = user._id;
  res.json({ redirect: "/auth.html" });
});

// LOGOUT
app.get("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

/* ---------- SOCKET.IO BUS TRACKING ---------- */

const buses = {};

io.on("connection", socket => {
  socket.on("driverLocation", ({ busId, lat, lon }) => {
    buses[busId] = { lat, lon };
    io.emit("fleetUpdate", buses);
  });

  socket.on("stopSharing", ({ busId }) => {
    delete buses[busId];
    io.emit("fleetUpdate", buses);
  });
});

server.listen(process.env.PORT, () => {
  console.log("🚀 Server running");
});
