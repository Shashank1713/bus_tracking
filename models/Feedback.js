const mongoose = require("mongoose");

const feedbackSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000
    },
    rating: {
      type: Number,
      min: 1,
      max: 5,
      default: 5
    }
  },
  { timestamps: true }
);

feedbackSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("Feedback", feedbackSchema);
