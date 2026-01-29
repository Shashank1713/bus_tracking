const mongoose = require("mongoose");

const busSchema = new mongoose.Schema({
  busId: { type: String, unique: true },
  lastLat: Number,
  lastLon: Number,
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Bus", busSchema);
