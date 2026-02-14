const mongoose = require("mongoose");

const busSchema = new mongoose.Schema(
  {
    busId: {
      type: String,
      required: true,
      unique: true
    },
    lastLat: Number,
    lastLon: Number
  },
  { timestamps: true }
);

module.exports = mongoose.model("Bus", busSchema);
