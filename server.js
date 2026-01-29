require("dotenv").config();
const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const { Server } = require("socket.io");

const Bus = require("./models/Bus");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));
app.use(express.json());

// MongoDB
mongoose.connect(process.env.MONGO_URL)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error", err));

// In-memory live data
const liveBuses = {};

io.on("connection", socket => {
  socket.on("driverLocation", async ({ busId, lat, lon }) => {
    if (!busId) return;

    liveBuses[busId] = { lat, lon };
    io.emit("fleetUpdate", liveBuses);

    await Bus.findOneAndUpdate(
      { busId },
      { lastLat: lat, lastLon: lon, updatedAt: new Date() },
      { upsert: true }
    );
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("🚀 Server running on", PORT);
});
