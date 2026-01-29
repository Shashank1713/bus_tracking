require("dotenv").config();
const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
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

/* ================= AUTH ================= */

// SIGN UP
app.post("/api/signup", async (req, res) => {
  const { username, password, role } = req.body;

  const exists = await User.findOne({ username });
  if (exists) {
    return res.status(400).json({ message: "User already exists. Please sign in." });
  }

  const hashed = await bcrypt.hash(password, 10);
  await User.create({ username, password: hashed, role });

  res.json({ message: "Signup successful. Please sign in." });
});

// SIGN IN
app.post("/api/signin", async (req, res) => {
  const { username, password } = req.body;

  const user = await User.findOne({ username });
  if (!user) {
    return res.status(401).json({ message: "User not found. Please sign up." });
  }

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) {
    return res.status(401).json({ message: "Wrong password" });
  }

  res.json({ role: user.role });
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
