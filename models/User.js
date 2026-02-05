const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema({
  email: { type: String, unique: true },
  password: String,
  role: { type: String, default: "user" },
  isVerified: { type: Boolean, default: false },
  otp: String,
  otpExpires: Date
});

module.exports = mongoose.model("User", UserSchema);
