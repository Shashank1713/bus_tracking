const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  email: { type: String, unique: true },
  role: {
    type: String,
    enum: ["driver", "user", "admin"],
    default: "user"
  }
});

module.exports = mongoose.model("User", userSchema);
