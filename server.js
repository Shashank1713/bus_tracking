require("dotenv").config();
const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const { Server } = require("socket.io");

const User = require("./models/User");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

/* Middleware */
app.use(express.json());
app.use(express.static("public"));

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false
}));

/* MongoDB */
mongoose.connect(process.env.MONGO_URL)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error", err));

/* AUTH APIs */

// Signup
app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ message: "All fields required" });

  const hashed = await bcrypt.hash(password, 10);

  try {
    await User.create({ name, email, password: hashed });
    res.json({ message: "Signup successful" });
  } catch {
    res.status(400).json({ message: "User already exists" });
  }
});

// Login
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email });
  if (!user) return res.status(401).json({ message: "Invalid credentials" });

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ message: "Invalid credentials" });

  req.session.userId = user._id;
  req.session.role = user.role;

  res.json({ message: "Login successful" });
});

// Logout
app.get("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ message: "Logged out" }));
});

// Protect Admin
function requireAdmin(req, res, next) {
  if (req.session.role !== "admin") {
    return res.status(403).send("Access denied");
  }
  next();
}

app.get("/admin.html", requireAdmin, (req, res) => {
  res.sendFile(__dirname + "/public/admin.html");
});

/* BUS TRACKING */
const liveBuses = {};

io.on("connection", socket => {

  socket.on("driverLocation", ({ busId, lat, lon }) => {
    liveBuses[busId] = { lat, lon };
    io.emit("fleetUpdate", liveBuses);
  });

  socket.on("stopSharing", ({ busId }) => {
    delete liveBuses[busId];
    io.emit("busStopped", busId);
  });

});

/* Start */
server.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Server running");
});
