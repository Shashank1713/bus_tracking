const mongoose = require("mongoose");

const tripSchema = new mongoose.Schema(
  {
    routeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Route",
      required: true
    },
    busId: {
      type: String,
      required: true,
      trim: true
    },
    operatorName: {
      type: String,
      default: "Friendly Travels"
    },
    departureTime: {
      type: Date,
      required: true
    },
    arrivalTime: {
      type: Date,
      required: true
    },
    durationMinutes: {
      type: Number,
      required: true
    },
    fare: {
      type: Number,
      required: true
    },
    totalSeats: {
      type: Number,
      default: 40
    },
    bookedSeats: {
      type: [String],
      default: []
    },
    amenities: {
      type: [String],
      default: []
    },
    status: {
      type: String,
      enum: ["scheduled", "cancelled", "completed"],
      default: "scheduled"
    }
  },
  { timestamps: true }
);

tripSchema.index({ routeId: 1, departureTime: 1 });
tripSchema.index({ busId: 1, departureTime: 1 }, { unique: true });

module.exports = mongoose.model("Trip", tripSchema);
