const mongoose = require("mongoose");

const passengerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    age: { type: Number, required: true, min: 1 },
    gender: { type: String, enum: ["male", "female", "other"], required: true },
    seatNumber: { type: String, required: true, trim: true }
  },
  { _id: false }
);

const bookingSchema = new mongoose.Schema(
  {
    pnr: {
      type: String,
      required: true,
      unique: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    tripId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Trip",
      required: true
    },
    source: { type: String, required: true },
    destination: { type: String, required: true },
    travelDate: { type: Date, required: true },
    passengers: {
      type: [passengerSchema],
      default: []
    },
    totalAmount: {
      type: Number,
      required: true
    },
    fareAmount: {
      type: Number,
      default: 0
    },
    gstAmount: {
      type: Number,
      default: 0
    },
    convenienceFee: {
      type: Number,
      default: 0
    },
    couponCode: {
      type: String,
      default: null
    },
    discountAmount: {
      type: Number,
      default: 0
    },
    walletUsed: {
      type: Number,
      default: 0
    },
    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "refunded"],
      default: "pending"
    },
    status: {
      type: String,
      enum: ["booked", "cancelled"],
      default: "booked"
    },
    paymentRef: {
      type: String,
      default: null
    },
    cancelledAt: {
      type: Date,
      default: null
    }
  },
  { timestamps: true }
);

bookingSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("Booking", bookingSchema);
