const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  mobile: { type: String, unique: true },
  otp: String,
  otpExpires: Date,
  isVerified: { type: Boolean, default: false }
});

module.exports = mongoose.model("User", userSchema);
