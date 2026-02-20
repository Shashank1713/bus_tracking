const mongoose = require("mongoose");

const routeSchema = new mongoose.Schema(
  {
    source: {
      type: String,
      required: true,
      trim: true
    },
    destination: {
      type: String,
      required: true,
      trim: true
    },
    distanceKm: {
      type: Number,
      default: 0
    },
    isActive: {
      type: Boolean,
      default: true
    }
  },
  { timestamps: true }
);

routeSchema.index({ source: 1, destination: 1 }, { unique: true });

module.exports = mongoose.model("Route", routeSchema);
