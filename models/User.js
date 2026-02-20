const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    firebaseUid: {
      type: String,
      unique: true,
      sparse: true
    },
    authProvider: {
      type: String,
      enum: ["direct", "fast2sms", "firebase"],
      default: "direct"
    },
    mobile: {
      type: String,
      sparse: true,
      unique: true
    },
    email: {
      type: String,
      sparse: true,
      unique: true,
      lowercase: true,
      trim: true
    },
    otpHash: String,
    otpExpires: Date,
    otpAttempts: {
      type: Number,
      default: 0
    },
    isVerified: {
      type: Boolean,
      default: false
    },
    role: {
      type: String,
      enum: ["user", "driver", "admin"],
      default: "user"
    },
    walletBalance: {
      type: Number,
      default: 0
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);
