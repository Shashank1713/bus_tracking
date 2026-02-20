require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const http = require("http");
const crypto = require("crypto");
const axios = require("axios");
const nodemailer = require("nodemailer");
const { Server } = require("socket.io");
const admin = require("firebase-admin");
const swaggerUi = require("swagger-ui-express");
const swaggerJSDoc = require("swagger-jsdoc");

const User = require("./models/User");
const Route = require("./models/Route");
const Trip = require("./models/Trip");
const Booking = require("./models/Booking");
const Feedback = require("./models/Feedback");
const { authenticate } = require("./middleware/auth");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ---------------- HELPERS ----------------
function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

requireEnv("MONGO_URL");
requireEnv("JWT_SECRET");

const OTP_PROVIDER = (
  process.env.OTP_PROVIDER ||
  (process.env.FAST2SMS_API_KEY ? "fast2sms" : "firebase")
).toLowerCase();

const OTP_TTL_MINUTES = Number(process.env.OTP_TTL_MINUTES || 5);
const OTP_FALLBACK_DEMO = process.env.OTP_FALLBACK_DEMO === "true";

function normalizeIndianMobile(rawMobile) {
  const digits = String(rawMobile || "").replace(/\D/g, "").slice(-10);
  if (!/^[6-9]\d{9}$/.test(digits)) {
    throw new Error("Invalid mobile number");
  }

  return {
    local: digits,
    e164: `+91${digits}`
  };
}

function normalizeEmail(rawEmail) {
  const email = String(rawEmail || "").trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    throw new Error("Invalid email");
  }
  return email;
}

function hashOtp(mobile, otp) {
  return crypto
    .createHash("sha256")
    .update(`${mobile}:${otp}:${process.env.JWT_SECRET}`)
    .digest("hex");
}

function createAppToken(user) {
  return jwt.sign(
    {
      sub: user._id.toString(),
      firebaseUid: user.firebaseUid || null,
      email: user.email || null,
      mobile: user.mobile,
      role: user.role
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function capitalize(value) {
  const text = String(value || "").trim();
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

function toDateOnlyIso(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function dayRange(dateInput) {
  const date = new Date(dateInput);
  if (Number.isNaN(date.getTime())) return null;
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 0, 0, 0));
  return { start, end };
}

function generatePnr() {
  const token = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `FT${Date.now().toString().slice(-6)}${token}`;
}

function ensureRole(roles) {
  const safeRoles = Array.isArray(roles) ? roles : [roles];
  return (req, res, next) => {
    if (!req.user || !safeRoles.includes(req.user.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    return next();
  };
}

function getPostLoginRedirect(role) {
  if (role === "admin") return "/admin-ops.html";
  if (role === "driver") return "/driver.html";
  return "/index.html";
}

const BUSINESS_RULES = {
  cancellationPolicy: ">24h 80% refund, 6-24h 50%, <6h 0%",
  coupon: {
    code: "FRIENDLY10",
    percent: 10,
    minFare: 500,
    maxDiscount: 200
  },
  gstPercent: 5,
  convenienceFeePercent: 2,
  convenienceFeeMin: 10,
  convenienceFeeMax: 40,
  seatLockTimeoutMinutes: 10
};

function moneyRound(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function computeFareBreakdown({ baseFare, seatCount, couponCode }) {
  const fareAmount = moneyRound(baseFare * seatCount);
  const gstAmount = moneyRound((fareAmount * BUSINESS_RULES.gstPercent) / 100);
  const computedFee = moneyRound((fareAmount * BUSINESS_RULES.convenienceFeePercent) / 100);
  const convenienceFee = Math.min(BUSINESS_RULES.convenienceFeeMax, Math.max(BUSINESS_RULES.convenienceFeeMin, computedFee));
  let discountAmount = 0;
  let appliedCoupon = null;

  if (
    couponCode &&
    String(couponCode).trim().toUpperCase() === BUSINESS_RULES.coupon.code &&
    fareAmount >= BUSINESS_RULES.coupon.minFare
  ) {
    discountAmount = moneyRound(
      Math.min(BUSINESS_RULES.coupon.maxDiscount, (fareAmount * BUSINESS_RULES.coupon.percent) / 100)
    );
    appliedCoupon = BUSINESS_RULES.coupon.code;
  }

  const totalAmount = moneyRound(Math.max(0, fareAmount + gstAmount + convenienceFee - discountAmount));
  return {
    fareAmount,
    gstAmount,
    convenienceFee,
    discountAmount,
    couponCode: appliedCoupon,
    totalAmount
  };
}

function calculateRefundPercent(departureTime) {
  const now = Date.now();
  const diffHours = (new Date(departureTime).getTime() - now) / (1000 * 60 * 60);
  if (diffHours > 24) return 80;
  if (diffHours >= 6) return 50;
  return 0;
}

async function sendBookingNotifications({ user, booking, eventType }) {
  const identity = user.email || user.mobile || "user";
  const message = `[${eventType}] Booking ${booking.pnr} for ${booking.source} to ${booking.destination} | Amount Rs ${booking.totalAmount}`;

  // In production, connect this to email/SMS providers.
  console.log(`NOTIFY -> ${identity}: ${message}`);
}

const gmailEnabled = Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
const smtpHost = process.env.SMTP_HOST || "smtp.gmail.com";
const smtpPort = Number(process.env.SMTP_PORT || 465);
const smtpSecure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : smtpPort === 465;
const mailTransporter = gmailEnabled
  ? nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      family: 4,
      connectionTimeout: 20000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
      }
    })
  : null;

function hasFirebaseAdminCredentials() {
  return Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY ||
      (process.env.FIREBASE_PROJECT_ID &&
        process.env.FIREBASE_CLIENT_EMAIL &&
        process.env.FIREBASE_PRIVATE_KEY)
  );
}

function getFirebaseServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  }

  return {
    project_id: process.env.FIREBASE_PROJECT_ID,
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
  };
}

let firebaseEnabled = false;
if (hasFirebaseAdminCredentials()) {
  const firebaseServiceAccount = getFirebaseServiceAccount();
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(firebaseServiceAccount)
    });
  }
  firebaseEnabled = true;
}

function getFirebaseClientConfig() {
  return {
    apiKey: process.env.FIREBASE_WEB_API_KEY,
    authDomain: process.env.FIREBASE_WEB_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_WEB_PROJECT_ID,
    appId: process.env.FIREBASE_WEB_APP_ID
  };
}

function getServerBaseUrl() {
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL;
  const port = process.env.PORT || 3000;
  return `http://localhost:${port}`;
}

async function sendOtpViaFast2Sms(localMobile, otp) {
  if (!process.env.FAST2SMS_API_KEY) {
    throw new Error("FAST2SMS_API_KEY is missing");
  }

  const params = {
    route: "otp",
    variables_values: otp,
    flash: 0,
    numbers: localMobile
  };

  if (process.env.FAST2SMS_SENDER_ID) {
    params.sender_id = process.env.FAST2SMS_SENDER_ID;
  }

  if (process.env.FAST2SMS_TEMPLATE_ID) {
    params.schedule_time = "";
    params.message = process.env.FAST2SMS_TEMPLATE_ID;
  }

  const response = await axios.get("https://www.fast2sms.com/dev/bulkV2", {
    params,
    headers: {
      authorization: process.env.FAST2SMS_API_KEY
    },
    timeout: 15000
  });

  if (!response.data || response.data.return !== true) {
    throw new Error("SMS provider rejected OTP request");
  }
}

const swaggerSpec = swaggerJSDoc({
  definition: {
    openapi: "3.0.3",
    info: {
      title: "Bus Tracking API",
      version: "1.0.0",
      description: "OTP authentication and bus tracking API"
    },
    servers: [{ url: getServerBaseUrl() }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT"
        }
      }
    },
    paths: {
      "/api/send-otp": {
        post: {
          summary: "Send OTP to Indian mobile number using FAST2SMS",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["mobile"],
                  properties: {
                    mobile: { type: "string", example: "9876543210" }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: "OTP sent" },
            400: { description: "Invalid number or bad request" },
            429: { description: "Rate limit or provider limit" },
            500: { description: "Provider/server error" }
          }
        }
      },
      "/api/auth/login": {
        post: {
          summary: "Direct mobile login without OTP",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["mobile"],
                  properties: {
                    mobile: { type: "string", example: "9876543210" }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: "Login success" },
            400: { description: "Invalid mobile number" }
          }
        }
      },
      "/api/auth/email/send-otp": {
        post: {
          summary: "Send OTP to email using Gmail SMTP",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["email"],
                  properties: {
                    email: { type: "string", example: "user@example.com" }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: "OTP sent to email" },
            400: { description: "Invalid email" },
            500: { description: "Mail provider error" }
          }
        }
      },
      "/api/auth/email/verify-otp": {
        post: {
          summary: "Verify email OTP and issue JWT",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["email", "otp"],
                  properties: {
                    email: { type: "string", example: "user@example.com" },
                    otp: { type: "string", example: "123456" }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: "OTP verified" },
            400: { description: "Invalid/expired OTP" },
            429: { description: "Too many attempts" }
          }
        }
      },
      "/api/verify-otp": {
        post: {
          summary: "Verify OTP and issue JWT",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["mobile", "otp"],
                  properties: {
                    mobile: { type: "string", example: "9876543210" },
                    otp: { type: "string", example: "123456" }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: "OTP verified" },
            400: { description: "Invalid or expired OTP" },
            429: { description: "Too many attempts" }
          }
        }
      },
      "/api/auth/verify-token": {
        post: {
          summary: "Verify Firebase ID token and issue app JWT",
          responses: {
            200: { description: "Token verified" },
            501: { description: "Firebase auth not configured" }
          }
        }
      },
      "/api/session-check": {
        get: {
          summary: "Validate JWT session",
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: "Session valid" },
            401: { description: "Session invalid" }
          }
        }
      },
      "/api/auth/me": {
        get: {
          summary: "Get authenticated user profile",
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: "User profile" },
            401: { description: "Unauthorized" },
            404: { description: "User not found" }
          }
        }
      },
      "/api/logout": {
        get: {
          summary: "Logout client session",
          responses: {
            200: { description: "Logout response" }
          }
        }
      }
    }
  },
  apis: []
});

// ---------------- MIDDLEWARE ----------------
app.use(express.json());
app.use(express.static("public"));
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ---------------- DB ----------------
mongoose
  .connect(process.env.MONGO_URL)
  .then(async () => {
    console.log("✅ MongoDB connected");
    try {
      // Align DB indexes with current schema (mobile/email are sparse unique).
      await User.syncIndexes();
      await Route.syncIndexes();
      await Trip.syncIndexes();
      await Booking.syncIndexes();
      await Feedback.syncIndexes();
    } catch (indexError) {
      console.error("⚠️ Index sync failed", indexError.message);
    }
  })
  .catch(err => console.log("❌ MongoDB error", err));

// ---------------- ROOT ----------------
app.get("/", (req, res) => {
  res.redirect("/login.html");
});

// ---------------- EXTENSION NOISE GUARDS ----------------
app.get("/favicon.ico", (req, res) => {
  res.sendStatus(204);
});

app.get("/hybridaction/zybTrackerStatisticsAction", (req, res) => {
  const callback = String(req.query.__callback__ || "").trim();
  if (!callback) {
    return res.json({ ok: true });
  }

  // Return safe JSONP for browser extensions that probe this path.
  if (!/^[a-zA-Z0-9_$.[\]]+$/.test(callback)) {
    return res.status(400).json({ error: "Invalid callback" });
  }

  res.type("application/javascript");
  return res.send(`${callback}(${JSON.stringify({ ok: true })});`);
});

// ---------------- API SPEC ----------------
app.get("/api/openapi.json", (req, res) => {
  res.json(swaggerSpec);
});

app.get("/api/config/auth-capabilities", (req, res) => {
  return res.json({
    emailOtpEnabled: gmailEnabled,
    smsOtpEnabled: Boolean(process.env.FAST2SMS_API_KEY),
    firebaseEnabled,
    otpProvider: OTP_PROVIDER
  });
});

// ---------------- EMAIL OTP ----------------
app.post("/api/auth/email/send-otp", async (req, res) => {
  try {
    if (!gmailEnabled) {
      return res.status(500).json({ error: "Gmail SMTP is not configured on this server." });
    }

    const email = normalizeEmail(req.body.email);
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpHash = hashOtp(email, otp);
    const otpExpires = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    await mailTransporter.sendMail({
      from: process.env.GMAIL_USER,
      to: email,
      subject: "Your Bus Tracking OTP",
      text: `Your OTP is ${otp}. It expires in ${OTP_TTL_MINUTES} minutes.`,
      html: `<p>Your OTP is <b>${otp}</b>.</p><p>It expires in ${OTP_TTL_MINUTES} minutes.</p>`
    });

    await User.findOneAndUpdate(
      { email },
      {
        email,
        authProvider: "direct",
        otpHash,
        otpExpires,
        otpAttempts: 0,
        isVerified: false
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.json({ message: "OTP sent to your email." });
  } catch (error) {
    if (error.message === "Invalid email") {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (error.responseCode === 550 || error.responseCode === 553) {
      return res.status(400).json({ error: "Recipient email is invalid or unavailable." });
    }
    if (error.code === "EAUTH") {
      return res.status(500).json({ error: "Gmail authentication failed. Check GMAIL_USER/GMAIL_APP_PASSWORD." });
    }
    if (error.code === "ETIMEDOUT" || error.code === "ECONNECTION") {
      return res.status(500).json({
        error: "Email provider connection timeout. Try Mobile OTP or configure SMTP_HOST/SMTP_PORT."
      });
    }
    console.error("email send-otp failed", error);
    return res.status(500).json({ error: "Failed to send email OTP. Please try again." });
  }
});

app.post("/api/auth/email/verify-otp", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const otp = String(req.body.otp || "").trim();

    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({ error: "Enter a valid 6-digit OTP." });
    }

    const user = await User.findOne({ email });
    if (!user || !user.otpHash || !user.otpExpires || user.otpExpires.getTime() < Date.now()) {
      return res.status(400).json({ error: "Invalid or expired OTP." });
    }

    if (user.otpAttempts >= 5) {
      return res.status(429).json({ error: "Too many failed attempts. Request a new OTP." });
    }

    if (hashOtp(email, otp) !== user.otpHash) {
      user.otpAttempts += 1;
      await user.save();
      return res.status(400).json({ error: "Invalid or expired OTP." });
    }

    user.otpHash = null;
    user.otpExpires = null;
    user.otpAttempts = 0;
    user.isVerified = true;
    user.authProvider = "direct";
    await user.save();

    const appToken = createAppToken(user);
    return res.json({
      token: appToken,
      user: {
        id: user._id,
        email: user.email,
        mobile: user.mobile,
        role: user.role
      },
      redirect: getPostLoginRedirect(user.role)
    });
  } catch (error) {
    if (error.message === "Invalid email") {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    console.error("email verify-otp failed", error);
    return res.status(500).json({ error: "Failed to verify OTP. Please try again." });
  }
});

// ---------------- DIRECT LOGIN (NO OTP) ----------------
app.post("/api/auth/login", async (req, res) => {
  try {
    const { e164 } = normalizeIndianMobile(req.body.mobile);

    const user = await User.findOneAndUpdate(
      { mobile: e164 },
      {
        mobile: e164,
        authProvider: "direct",
        isVerified: true,
        otpHash: null,
        otpExpires: null,
        otpAttempts: 0
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const appToken = createAppToken(user);
    return res.json({
      token: appToken,
      user: {
        id: user._id,
        mobile: user.mobile,
        role: user.role
      },
      redirect: getPostLoginRedirect(user.role)
    });
  } catch (error) {
    if (error.message === "Invalid mobile number") {
      return res.status(400).json({ error: "Enter a valid Indian mobile number" });
    }
    console.error("direct login failed", error);
    return res.status(500).json({ error: "Login failed. Please try again." });
  }
});

// ---------------- FIREBASE WEB CONFIG ----------------
app.get("/api/config/firebase", (req, res) => {
  const clientConfig = getFirebaseClientConfig();
  if (Object.values(clientConfig).some(value => !value)) {
    return res.status(500).json({ error: "Firebase Web config is incomplete" });
  }
  return res.json(clientConfig);
});

// ---------------- FAST2SMS SEND OTP ----------------
app.post("/api/send-otp", async (req, res) => {
  let normalized;
  let otp;

  try {
    if (OTP_PROVIDER !== "fast2sms") {
      return res.status(400).json({ error: "Server OTP provider is not set to FAST2SMS" });
    }

    normalized = normalizeIndianMobile(req.body.mobile);
    const { e164, local } = normalized;
    otp = Math.floor(100000 + Math.random() * 900000).toString();

    await sendOtpViaFast2Sms(local, otp);

    const otpHash = hashOtp(e164, otp);
    const otpExpires = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    await User.findOneAndUpdate(
      { mobile: e164 },
      {
        mobile: e164,
        authProvider: "fast2sms",
        otpHash,
        otpExpires,
        otpAttempts: 0,
        isVerified: false
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.json({ message: "OTP sent successfully" });
  } catch (error) {
    const providerData = error.response?.data;
    const providerMessage = providerData?.message || "";
    const canFallback = OTP_FALLBACK_DEMO && normalized && otp;

    if (error.message === "Invalid mobile number") {
      return res.status(400).json({ error: "Enter a valid Indian mobile number" });
    }

    if (canFallback) {
      const otpHash = hashOtp(normalized.e164, otp);
      const otpExpires = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

      await User.findOneAndUpdate(
        { mobile: normalized.e164 },
        {
          mobile: normalized.e164,
          authProvider: "fast2sms",
          otpHash,
          otpExpires,
          otpAttempts: 0,
          isVerified: false
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      const response = {
        message: "SMS provider unavailable. OTP generated in demo fallback mode."
      };

      if (process.env.NODE_ENV !== "production") {
        response.demoOtp = otp;
      }

      console.warn("send-otp fallback mode active:", providerData || error.message);
      return res.status(200).json(response);
    }

    if (providerData?.status_code === 412 || providerMessage.includes("Invalid Authentication")) {
      return res.status(500).json({ error: "FAST2SMS API key is invalid. Update FAST2SMS_API_KEY in .env." });
    }

    if (String(error.message || "").includes("rejected OTP request")) {
      return res.status(429).json({ error: "SMS quota/limit reached. Try again later." });
    }

    console.error("send-otp failed", error.response?.data || error.message || error);
    return res.status(500).json({ error: "OTP could not be sent. Please try again." });
  }
});

// ---------------- FAST2SMS VERIFY OTP ----------------
app.post("/api/verify-otp", async (req, res) => {
  try {
    const { e164 } = normalizeIndianMobile(req.body.mobile);
    const otp = String(req.body.otp || "").trim();

    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({ error: "Enter a valid 6-digit OTP" });
    }

    const user = await User.findOne({ mobile: e164 });
    if (!user || !user.otpHash || !user.otpExpires || user.otpExpires.getTime() < Date.now()) {
      return res.status(400).json({ error: "Invalid or expired OTP" });
    }

    if (user.otpAttempts >= 5) {
      return res.status(429).json({ error: "Too many failed attempts. Request a new OTP." });
    }

    if (hashOtp(e164, otp) !== user.otpHash) {
      user.otpAttempts += 1;
      await user.save();
      return res.status(400).json({ error: "Invalid or expired OTP" });
    }

    user.otpHash = null;
    user.otpExpires = null;
    user.otpAttempts = 0;
    user.isVerified = true;
    user.authProvider = "fast2sms";
    await user.save();

    const appToken = createAppToken(user);

    return res.json({
      token: appToken,
      user: {
        id: user._id,
        mobile: user.mobile,
        role: user.role
      },
      redirect: getPostLoginRedirect(user.role)
    });
  } catch (error) {
    if (error.message === "Invalid mobile number") {
      return res.status(400).json({ error: "Enter a valid Indian mobile number" });
    }

    console.error("verify-otp failed", error);
    return res.status(500).json({ error: "OTP verification failed. Please try again." });
  }
});

// ---------------- VERIFY FIREBASE TOKEN ----------------
app.post("/api/auth/verify-token", async (req, res) => {
  try {
    if (!firebaseEnabled) {
      return res.status(501).json({ error: "Firebase auth is not configured on this server" });
    }

    const { idToken } = req.body;
    if (!idToken) {
      return res.status(400).json({ error: "Missing Firebase ID token" });
    }

    const decoded = await admin.auth().verifyIdToken(idToken);
    const mobile = decoded.phone_number;
    if (!mobile) {
      return res.status(400).json({ error: "Phone number is required" });
    }

    const user = await User.findOneAndUpdate(
      { mobile },
      {
        firebaseUid: decoded.uid,
        mobile,
        authProvider: "firebase",
        isVerified: true,
        otpHash: null,
        otpExpires: null,
        otpAttempts: 0
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const appToken = createAppToken(user);

    return res.json({
      token: appToken,
      user: {
        id: user._id,
        mobile: user.mobile,
        role: user.role
      },
      redirect: getPostLoginRedirect(user.role)
    });
  } catch (error) {
    const firebaseCode = error.code || "";
    if (firebaseCode === "auth/id-token-expired") {
      return res.status(401).json({ error: "Login token expired. Please retry OTP." });
    }
    if (firebaseCode === "auth/argument-error" || firebaseCode === "auth/invalid-id-token") {
      return res.status(401).json({ error: "Invalid login token. Please retry OTP." });
    }
    console.error("verify-token failed", error);
    return res.status(500).json({ error: "Unable to verify login. Please try again." });
  }
});

// ---------------- AUTH CHECK ----------------
app.get("/api/session-check", authenticate, (req, res) => {
  res.sendStatus(200);
});

app.get("/api/auth/me", authenticate, async (req, res) => {
  const user = await User.findById(req.user.sub).lean();
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  return res.json({
    id: user._id,
    email: user.email,
    mobile: user.mobile,
    role: user.role
  });
});

// ---------------- LOGOUT ----------------
app.get("/api/logout", (req, res) => {
  res.json({ success: true });
});

// ---------------- SEARCH / BOOKING / PAYMENTS ----------------
app.get("/api/config/business-rules", (req, res) => {
  return res.json({
    cancellationPolicy: BUSINESS_RULES.cancellationPolicy,
    coupon: BUSINESS_RULES.coupon,
    gstPercent: BUSINESS_RULES.gstPercent,
    convenienceFeePercent: BUSINESS_RULES.convenienceFeePercent,
    convenienceFeeMin: BUSINESS_RULES.convenienceFeeMin,
    convenienceFeeMax: BUSINESS_RULES.convenienceFeeMax,
    seatLockTimeoutMinutes: BUSINESS_RULES.seatLockTimeoutMinutes
  });
});

app.get("/api/routes", async (req, res) => {
  const source = String(req.query.source || "").trim();
  const destination = String(req.query.destination || "").trim();
  const filter = { isActive: true };
  if (source) filter.source = new RegExp(`^${source}$`, "i");
  if (destination) filter.destination = new RegExp(`^${destination}$`, "i");

  const routes = await Route.find(filter).sort({ source: 1, destination: 1 }).lean();
  return res.json({ routes });
});

app.post("/api/coupons/apply", authenticate, (req, res) => {
  const couponCode = String(req.body?.couponCode || "").trim().toUpperCase();
  const baseFare = Number(req.body?.baseFare || 0);
  const seatCount = Number(req.body?.seatCount || 0);

  if (!(baseFare > 0) || !(seatCount > 0)) {
    return res.status(400).json({ error: "baseFare and seatCount must be positive" });
  }

  const breakdown = computeFareBreakdown({ baseFare, seatCount, couponCode });
  return res.json({
    valid: Boolean(breakdown.couponCode),
    ...breakdown
  });
});

app.get("/api/wallet", authenticate, async (req, res) => {
  const user = await User.findById(req.user.sub).lean();
  if (!user) return res.status(404).json({ error: "User not found" });

  return res.json({
    balance: moneyRound(user.walletBalance || 0)
  });
});

app.post("/api/wallet/add-funds", authenticate, async (req, res) => {
  const amount = Number(req.body?.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "Valid amount is required" });
  }

  const user = await User.findByIdAndUpdate(
    req.user.sub,
    { $inc: { walletBalance: amount } },
    { new: true }
  ).lean();

  return res.json({
    message: "Wallet updated",
    balance: moneyRound(user.walletBalance || 0)
  });
});

app.get("/api/trips/search", async (req, res) => {
  try {
    const source = String(req.query.source || "").trim();
    const destination = String(req.query.destination || "").trim();
    const date = String(req.query.date || "").trim();

    if (!source || !destination || !date) {
      return res.status(400).json({ error: "source, destination and date are required" });
    }

    const range = dayRange(date);
    if (!range) return res.status(400).json({ error: "Invalid date" });

    const route = await Route.findOne({
      source: new RegExp(`^${source}$`, "i"),
      destination: new RegExp(`^${destination}$`, "i"),
      isActive: true
    }).lean();

    if (!route) {
      return res.json({ trips: [], routeExists: false });
    }

    const trips = await Trip.find({
      routeId: route._id,
      departureTime: { $gte: range.start, $lt: range.end },
      status: "scheduled"
    })
      .sort({ departureTime: 1 })
      .lean();

    const enrichedTrips = trips.map((trip) => {
      const availableSeats = Math.max(0, trip.totalSeats - (trip.bookedSeats?.length || 0));
      return {
        ...trip,
        source: route.source,
        destination: route.destination,
        availableSeats
      };
    });

    return res.json({
      routeExists: true,
      trips: enrichedTrips
    });
  } catch (error) {
    console.error("trip search failed", error);
    return res.status(500).json({ error: "Unable to search trips" });
  }
});

app.get("/api/trips/:tripId", async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.tripId).populate("routeId").lean();
    if (!trip) return res.status(404).json({ error: "Trip not found" });
    const route = trip.routeId;
    const availableSeats = Math.max(0, trip.totalSeats - (trip.bookedSeats?.length || 0));
    return res.json({
      trip: {
        ...trip,
        source: route?.source || null,
        destination: route?.destination || null,
        availableSeats
      }
    });
  } catch (error) {
    return res.status(400).json({ error: "Invalid trip id" });
  }
});

app.post("/api/payments/create-order", authenticate, async (req, res) => {
  const amount = Number(req.body?.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "Valid amount is required" });
  }

  const orderId = `order_${crypto.randomBytes(6).toString("hex")}`;
  return res.json({
    orderId,
    amount,
    currency: "INR",
    provider: "mock"
  });
});

app.post("/api/bookings", authenticate, async (req, res) => {
  try {
    const { tripId, seats, passengers, paymentOrderId, couponCode, useWallet } = req.body || {};
    const safeTripId = String(tripId || "").trim();
    const safeSeats = Array.isArray(seats) ? seats.map((seat) => String(seat).trim()).filter(Boolean) : [];
    const safePassengers = Array.isArray(passengers) ? passengers : [];

    if (!safeTripId) return res.status(400).json({ error: "tripId is required" });
    if (!safeSeats.length) return res.status(400).json({ error: "At least one seat must be selected" });
    if (safePassengers.length !== safeSeats.length) {
      return res.status(400).json({ error: "Passengers count must match selected seats" });
    }

    const trip = await Trip.findById(safeTripId).populate("routeId");
    if (!trip) return res.status(404).json({ error: "Trip not found" });
    if (trip.status !== "scheduled") return res.status(400).json({ error: "Trip is not available for booking" });

    const alreadyBooked = safeSeats.filter((seat) => trip.bookedSeats.includes(seat));
    if (alreadyBooked.length) {
      return res.status(409).json({ error: `Seat(s) unavailable: ${alreadyBooked.join(", ")}` });
    }

    const normalizedPassengers = safePassengers.map((passenger, idx) => ({
      name: String(passenger?.name || "").trim(),
      age: Number(passenger?.age || 0),
      gender: String(passenger?.gender || "").trim().toLowerCase(),
      seatNumber: safeSeats[idx]
    }));

    const invalidPassenger = normalizedPassengers.find(
      (p) => !p.name || !Number.isFinite(p.age) || p.age <= 0 || !["male", "female", "other"].includes(p.gender)
    );
    if (invalidPassenger) {
      return res.status(400).json({ error: "Each passenger needs valid name, age and gender" });
    }

    trip.bookedSeats.push(...safeSeats);
    await trip.save();

    const user = await User.findById(req.user.sub);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const breakdown = computeFareBreakdown({
      baseFare: trip.fare,
      seatCount: safeSeats.length,
      couponCode
    });

    let walletUsed = 0;
    if (useWallet) {
      walletUsed = Math.min(Number(user.walletBalance || 0), breakdown.totalAmount);
      user.walletBalance = moneyRound((user.walletBalance || 0) - walletUsed);
      await user.save();
    }

    const finalTotal = moneyRound(Math.max(0, breakdown.totalAmount - walletUsed));
    const booking = await Booking.create({
      pnr: generatePnr(),
      userId: req.user.sub,
      tripId: trip._id,
      source: trip.routeId.source,
      destination: trip.routeId.destination,
      travelDate: trip.departureTime,
      passengers: normalizedPassengers,
      totalAmount: finalTotal,
      fareAmount: breakdown.fareAmount,
      gstAmount: breakdown.gstAmount,
      convenienceFee: breakdown.convenienceFee,
      couponCode: breakdown.couponCode,
      discountAmount: breakdown.discountAmount,
      walletUsed,
      paymentStatus: "paid",
      paymentRef: paymentOrderId ? String(paymentOrderId) : `mockpay_${Date.now()}`
    });

    await sendBookingNotifications({
      user,
      booking,
      eventType: "BOOKED"
    });

    return res.status(201).json({
      message: "Booking confirmed",
      booking: {
        id: booking._id,
        pnr: booking.pnr,
        source: booking.source,
        destination: booking.destination,
        travelDate: booking.travelDate,
        seats: safeSeats,
        fareAmount: booking.fareAmount,
        gstAmount: booking.gstAmount,
        convenienceFee: booking.convenienceFee,
        discountAmount: booking.discountAmount,
        walletUsed: booking.walletUsed,
        totalAmount: booking.totalAmount,
        status: booking.status
      }
    });
  } catch (error) {
    console.error("booking failed", error);
    return res.status(500).json({ error: "Unable to create booking" });
  }
});

app.get("/api/bookings/my", authenticate, async (req, res) => {
  const bookings = await Booking.find({ userId: req.user.sub })
    .sort({ createdAt: -1 })
    .populate({
      path: "tripId",
      populate: { path: "routeId" }
    })
    .lean();

  const payload = bookings.map((booking) => ({
    id: booking._id,
    pnr: booking.pnr,
    status: booking.status,
    paymentStatus: booking.paymentStatus,
    source: booking.source,
    destination: booking.destination,
    travelDate: booking.travelDate,
    seats: booking.passengers.map((passenger) => passenger.seatNumber),
    fareAmount: booking.fareAmount || 0,
    gstAmount: booking.gstAmount || 0,
    convenienceFee: booking.convenienceFee || 0,
    discountAmount: booking.discountAmount || 0,
    walletUsed: booking.walletUsed || 0,
    totalAmount: booking.totalAmount,
    trip: booking.tripId
      ? {
          id: booking.tripId._id,
          busId: booking.tripId.busId,
          operatorName: booking.tripId.operatorName,
          departureTime: booking.tripId.departureTime,
          arrivalTime: booking.tripId.arrivalTime
        }
      : null
  }));

  return res.json({ bookings: payload });
});

app.post("/api/bookings/:bookingId/cancel", authenticate, async (req, res) => {
  const booking = await Booking.findOne({ _id: req.params.bookingId, userId: req.user.sub });
  if (!booking) return res.status(404).json({ error: "Booking not found" });
  if (booking.status === "cancelled") return res.status(400).json({ error: "Booking is already cancelled" });

  const trip = await Trip.findById(booking.tripId);
  if (trip) {
    const seatsToRelease = new Set(booking.passengers.map((p) => p.seatNumber));
    trip.bookedSeats = trip.bookedSeats.filter((seat) => !seatsToRelease.has(seat));
    await trip.save();
  }

  const refundPercent = calculateRefundPercent(booking.travelDate);
  const refundAmount = moneyRound((booking.totalAmount * refundPercent) / 100);

  booking.status = "cancelled";
  booking.paymentStatus = "refunded";
  booking.cancelledAt = new Date();
  await booking.save();

  const user = await User.findByIdAndUpdate(
    req.user.sub,
    { $inc: { walletBalance: refundAmount } },
    { new: true }
  ).lean();

  await sendBookingNotifications({
    user,
    booking,
    eventType: `CANCELLED_REFUND_${refundPercent}%`
  });

  return res.json({
    message: "Booking cancelled and refund initiated",
    bookingId: booking._id,
    refundPercent,
    refundAmount,
    walletBalance: moneyRound(user?.walletBalance || 0)
  });
});

app.get("/api/bookings/:bookingId", authenticate, async (req, res) => {
  const booking = await Booking.findOne({ _id: req.params.bookingId, userId: req.user.sub })
    .populate({ path: "tripId", populate: { path: "routeId" } })
    .lean();
  if (!booking) return res.status(404).json({ error: "Booking not found" });
  return res.json({ booking });
});

app.get("/api/bookings/:bookingId/ticket", authenticate, async (req, res) => {
  const booking = await Booking.findOne({ _id: req.params.bookingId, userId: req.user.sub }).lean();
  if (!booking) return res.status(404).json({ error: "Booking not found" });

  const seats = booking.passengers.map((passenger) => passenger.seatNumber).join(", ");
  const html = `<!doctype html><html><head><meta charset="utf-8"/><title>Ticket ${booking.pnr}</title></head><body style="font-family:Arial,sans-serif;padding:24px;"><h2>Friendly Travels E-Ticket</h2><p><b>PNR:</b> ${booking.pnr}</p><p><b>Route:</b> ${booking.source} to ${booking.destination}</p><p><b>Travel Date:</b> ${new Date(booking.travelDate).toLocaleString()}</p><p><b>Seats:</b> ${seats}</p><p><b>Total:</b> Rs ${booking.totalAmount}</p><p><b>Status:</b> ${booking.status}</p></body></html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.send(html);
});

app.get("/api/bookings/:bookingId/invoice", authenticate, async (req, res) => {
  const booking = await Booking.findOne({ _id: req.params.bookingId, userId: req.user.sub }).lean();
  if (!booking) return res.status(404).json({ error: "Booking not found" });

  return res.json({
    invoice: {
      invoiceNumber: `INV-${booking.pnr}`,
      pnr: booking.pnr,
      gstPercent: BUSINESS_RULES.gstPercent,
      fareAmount: booking.fareAmount || booking.totalAmount,
      gstAmount: booking.gstAmount || 0,
      convenienceFee: booking.convenienceFee || 0,
      discountAmount: booking.discountAmount || 0,
      walletUsed: booking.walletUsed || 0,
      totalAmount: booking.totalAmount,
      issuedAt: booking.createdAt
    }
  });
});

app.post("/api/feedback", authenticate, async (req, res) => {
  const message = String(req.body?.message || "").trim();
  const rating = Number(req.body?.rating || 5);
  if (!message) return res.status(400).json({ error: "Feedback message is required" });

  const feedback = await Feedback.create({
    userId: req.user.sub,
    message,
    rating
  });

  return res.status(201).json({
    message: "Feedback submitted",
    feedbackId: feedback._id
  });
});

app.get("/api/feedback/my", authenticate, async (req, res) => {
  const feedback = await Feedback.find({ userId: req.user.sub }).sort({ createdAt: -1 }).lean();
  return res.json({ feedback });
});

// ---------------- ADMIN / OPERATOR ----------------
app.get("/api/admin/routes", authenticate, async (req, res) => {
  const routes = await Route.find({}).sort({ source: 1, destination: 1 }).lean();
  return res.json({ routes });
});

app.post("/api/admin/routes", authenticate, async (req, res) => {
  try {
    const source = capitalize(req.body?.source);
    const destination = capitalize(req.body?.destination);
    const distanceKm = Number(req.body?.distanceKm || 0);
    if (!source || !destination) return res.status(400).json({ error: "source and destination are required" });
    if (source.toLowerCase() === destination.toLowerCase()) {
      return res.status(400).json({ error: "source and destination must be different" });
    }

    const route = await Route.findOneAndUpdate(
      { source, destination },
      { source, destination, distanceKm, isActive: true },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.status(201).json({ message: "Route saved", route });
  } catch (error) {
    return res.status(500).json({ error: "Unable to save route" });
  }
});

app.get("/api/admin/trips", authenticate, async (req, res) => {
  const date = String(req.query.date || "").trim();
  const filter = {};
  if (date) {
    const range = dayRange(date);
    if (range) filter.departureTime = { $gte: range.start, $lt: range.end };
  }

  const trips = await Trip.find(filter).populate("routeId").sort({ departureTime: 1 }).lean();
  return res.json({ trips });
});

app.post("/api/admin/trips", authenticate, async (req, res) => {
  try {
    const source = capitalize(req.body?.source);
    const destination = capitalize(req.body?.destination);
    const busId = String(req.body?.busId || "").trim();
    const departureTime = new Date(req.body?.departureTime);
    const arrivalTime = new Date(req.body?.arrivalTime);
    const fare = Number(req.body?.fare || 0);
    const totalSeats = Number(req.body?.totalSeats || 40);
    const amenities = Array.isArray(req.body?.amenities) ? req.body.amenities.map(String) : [];

    if (!source || !destination || !busId) {
      return res.status(400).json({ error: "source, destination and busId are required" });
    }
    if (Number.isNaN(departureTime.getTime()) || Number.isNaN(arrivalTime.getTime())) {
      return res.status(400).json({ error: "Valid departureTime and arrivalTime are required" });
    }
    if (!(fare > 0)) return res.status(400).json({ error: "fare must be greater than 0" });
    if (!(totalSeats > 0)) return res.status(400).json({ error: "totalSeats must be greater than 0" });

    let route = await Route.findOne({ source, destination });
    if (!route) {
      route = await Route.create({ source, destination, distanceKm: 0, isActive: true });
    }

    const durationMinutes = Math.max(1, Math.round((arrivalTime.getTime() - departureTime.getTime()) / 60000));
    const trip = await Trip.create({
      routeId: route._id,
      busId,
      departureTime,
      arrivalTime,
      fare,
      totalSeats,
      durationMinutes,
      amenities
    });

    return res.status(201).json({ message: "Trip created", trip });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ error: "Trip with same bus and departure already exists" });
    }
    return res.status(500).json({ error: "Unable to create trip" });
  }
});

app.post("/api/admin/seed-demo", async (req, res) => {
  try {
    const demoRoutes = [
      { source: "Bangalore", destination: "Hyderabad", distanceKm: 570 },
      { source: "Bangalore", destination: "Pune", distanceKm: 842 },
      { source: "Bangalore", destination: "Mumbai", distanceKm: 982 },
      { source: "Bangalore", destination: "Mangalore", distanceKm: 352 },
      { source: "Bangalore", destination: "Mysore", distanceKm: 146 }
    ];

    const now = new Date();
    const day0 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
    const day1 = new Date(day0.getTime() + 24 * 60 * 60 * 1000);

    const createdRoutes = [];
    for (const item of demoRoutes) {
      const route = await Route.findOneAndUpdate(
        { source: item.source, destination: item.destination },
        { ...item, isActive: true },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      createdRoutes.push(route);
    }

    const tripTemplates = [
      { hour: 19, minute: 15, duration: 555, fare: 1275, busId: "BUS-101", route: "Bangalore|Hyderabad" },
      { hour: 20, minute: 15, duration: 555, fare: 1275, busId: "BUS-202", route: "Bangalore|Hyderabad" },
      { hour: 21, minute: 0, duration: 555, fare: 1530, busId: "BUS-303", route: "Bangalore|Hyderabad" },
      { hour: 21, minute: 30, duration: 720, fare: 1390, busId: "BUS-404", route: "Bangalore|Pune" },
      { hour: 22, minute: 0, duration: 780, fare: 1490, busId: "BUS-505", route: "Bangalore|Mumbai" },
      { hour: 18, minute: 45, duration: 420, fare: 980, busId: "BUS-606", route: "Bangalore|Mangalore" },
      { hour: 7, minute: 30, duration: 210, fare: 550, busId: "BUS-707", route: "Bangalore|Mysore" }
    ];

    let upserts = 0;
    for (const tripDay of [day0, day1]) {
      for (const tpl of tripTemplates) {
        const [source, destination] = tpl.route.split("|");
        const route = createdRoutes.find((r) => r.source === source && r.destination === destination);
        if (!route) continue;

        const departureTime = new Date(tripDay);
        departureTime.setUTCHours(tpl.hour, tpl.minute, 0, 0);
        const arrivalTime = new Date(departureTime.getTime() + tpl.duration * 60000);

        await Trip.findOneAndUpdate(
          { busId: tpl.busId, departureTime },
          {
            routeId: route._id,
            busId: tpl.busId,
            operatorName: "Friendly Travels",
            departureTime,
            arrivalTime,
            durationMinutes: tpl.duration,
            fare: tpl.fare,
            totalSeats: 40,
            amenities: ["Live Tracking", "Water Bottle", "Charging Point"],
            status: "scheduled"
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        upserts += 1;
      }
    }

    return res.json({
      ok: true,
      message: "Demo routes and trips are ready",
      routes: createdRoutes.length,
      tripsUpserted: upserts,
      dates: [toDateOnlyIso(day0), toDateOnlyIso(day1)]
    });
  } catch (error) {
    console.error("seed demo failed", error);
    return res.status(500).json({ error: "Failed to seed demo data" });
  }
});

// ---------------- LIVE BUS TRACKING ----------------
const buses = {};
const simulatorJobs = new Map();

const cityCoordinates = {
  bangalore: { lat: 12.9716, lon: 77.5946 },
  bengaluru: { lat: 12.9716, lon: 77.5946 },
  hyderabad: { lat: 17.385, lon: 78.4867 },
  pune: { lat: 18.5204, lon: 73.8567 },
  mumbai: { lat: 19.076, lon: 72.8777 },
  mysore: { lat: 12.2958, lon: 76.6394 },
  mangalore: { lat: 12.9141, lon: 74.856 },
  goa: { lat: 15.2993, lon: 74.124 },
  ahmedabad: { lat: 23.0225, lon: 72.5714 },
  nagpur: { lat: 21.1458, lon: 79.0882 },
  shirdi: { lat: 19.7645, lon: 74.4774 }
};

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeCoordinate(lat, lon) {
  const parsedLat = toFiniteNumber(lat);
  const parsedLon = toFiniteNumber(lon);
  if (parsedLat === null || parsedLon === null) return null;
  if (parsedLat < -90 || parsedLat > 90 || parsedLon < -180 || parsedLon > 180) return null;
  return { lat: parsedLat, lon: parsedLon };
}

function emitTrackingUpdate(busId) {
  const bus = buses[busId];
  if (!bus) return;
  io.to(`bus:${busId}`).emit("busLocation", bus);
  io.emit("fleetUpdate", buses);
}

function upsertBusLocation(busId, payload) {
  const coordinates = normalizeCoordinate(payload.lat, payload.lon);
  if (!coordinates) return false;

  buses[busId] = {
    busId,
    lat: coordinates.lat,
    lon: coordinates.lon,
    speed: toFiniteNumber(payload.speed) || 0,
    heading: toFiniteNumber(payload.heading) || 0,
    source: payload.source || buses[busId]?.source || null,
    destination: payload.destination || buses[busId]?.destination || null,
    tripDate: payload.tripDate || buses[busId]?.tripDate || null,
    updatedAt: Date.now()
  };

  emitTrackingUpdate(busId);
  return true;
}

function stopSimulator(busId) {
  const job = simulatorJobs.get(busId);
  if (!job) return false;
  clearInterval(job.intervalId);
  simulatorJobs.delete(busId);
  return true;
}

function getCityPoint(cityName, fallbackKey) {
  const key = String(cityName || "").trim().toLowerCase();
  return cityCoordinates[key] || cityCoordinates[fallbackKey];
}

function buildRoutePoints(startPoint, endPoint, count = 60) {
  const points = [];
  for (let i = 0; i <= count; i += 1) {
    const t = i / count;
    // Add slight curve so movement does not look perfectly linear.
    const arc = Math.sin(t * Math.PI) * 0.18;
    points.push({
      lat: startPoint.lat + (endPoint.lat - startPoint.lat) * t + arc * 0.06,
      lon: startPoint.lon + (endPoint.lon - startPoint.lon) * t + arc * -0.05
    });
  }
  return points;
}

function startSimulator({ busId, source, destination, tripDate }) {
  stopSimulator(busId);
  const startPoint = getCityPoint(source, "bangalore");
  const endPoint = getCityPoint(destination, "hyderabad");
  const route = buildRoutePoints(startPoint, endPoint, 72);

  let index = 0;
  let direction = 1;

  // Push an immediate update so the UI gets location without waiting for first interval tick.
  upsertBusLocation(busId, {
    lat: route[index].lat,
    lon: route[index].lon,
    speed: 58,
    heading: 90,
    source,
    destination,
    tripDate
  });

  const intervalId = setInterval(() => {
    index += direction;
    if (index >= route.length - 1) {
      direction = -1;
      index = route.length - 1;
    } else if (index <= 0) {
      direction = 1;
      index = 0;
    }

    const current = route[index];
    const next = route[Math.min(index + 1, route.length - 1)];
    const heading = ((Math.atan2(next.lon - current.lon, next.lat - current.lat) * 180) / Math.PI + 360) % 360;

    upsertBusLocation(busId, {
      lat: current.lat,
      lon: current.lon,
      speed: 52 + Math.floor(Math.random() * 18),
      heading,
      source,
      destination,
      tripDate
    });
  }, 5000);

  simulatorJobs.set(busId, { intervalId });
}

app.get("/api/tracking/buses", (req, res) => {
  return res.json({ buses });
});

app.get("/api/tracking/buses/:busId", (req, res) => {
  const busId = String(req.params.busId || "").trim();
  if (!busId) return res.status(400).json({ error: "busId is required" });

  const bus = buses[busId];
  if (!bus) return res.status(404).json({ error: "Bus location not found" });

  return res.json({ bus });
});

app.post("/api/tracking/update", (req, res) => {
  const { busId, lat, lon, speed, heading, source, destination, tripDate } = req.body || {};
  const safeBusId = String(busId || "").trim();
  if (!safeBusId) return res.status(400).json({ error: "busId is required" });

  const accepted = upsertBusLocation(safeBusId, {
    lat,
    lon,
    speed,
    heading,
    source,
    destination,
    tripDate
  });
  if (!accepted) return res.status(400).json({ error: "Valid lat/lon is required" });

  return res.json({ ok: true, bus: buses[safeBusId] });
});

app.post("/api/tracking/simulator/start", (req, res) => {
  const safeBusId = String(req.body?.busId || "").trim();
  const source = String(req.body?.source || "Bangalore").trim();
  const destination = String(req.body?.destination || "Hyderabad").trim();
  const tripDate = String(req.body?.tripDate || "").trim() || null;

  if (!safeBusId) return res.status(400).json({ error: "busId is required" });

  startSimulator({ busId: safeBusId, source, destination, tripDate });
  return res.json({
    ok: true,
    message: "Simulator started",
    bus: buses[safeBusId]
  });
});

app.post("/api/tracking/simulator/stop", (req, res) => {
  const safeBusId = String(req.body?.busId || "").trim();
  if (!safeBusId) return res.status(400).json({ error: "busId is required" });

  const stopped = stopSimulator(safeBusId);
  return res.json({
    ok: true,
    stopped,
    bus: buses[safeBusId] || null
  });
});

io.on("connection", socket => {
  socket.on("joinBus", ({ busId }) => {
    const safeBusId = String(busId || "").trim();
    if (!safeBusId) return;
    socket.join(`bus:${safeBusId}`);
    if (buses[safeBusId]) {
      socket.emit("busLocation", buses[safeBusId]);
    }
  });

  socket.on("leaveBus", ({ busId }) => {
    const safeBusId = String(busId || "").trim();
    if (!safeBusId) return;
    socket.leave(`bus:${safeBusId}`);
  });

  socket.on("driverLocation", ({ busId, lat, lon, speed, heading, source, destination, tripDate }) => {
    const safeBusId = String(busId || "").trim();
    if (!safeBusId) return;
    upsertBusLocation(safeBusId, { lat, lon, speed, heading, source, destination, tripDate });
  });

  socket.on("stopSharing", ({ busId }) => {
    const safeBusId = String(busId || "").trim();
    if (!safeBusId) return;
    stopSimulator(safeBusId);
    delete buses[safeBusId];
    io.emit("fleetUpdate", buses);
  });
});

// ---------------- START ----------------
const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`🚀 Server running on port ${port} | OTP provider: ${OTP_PROVIDER}`);
  if (!gmailEnabled) {
    console.warn("⚠️ Email OTP is disabled: GMAIL_USER/GMAIL_APP_PASSWORD missing.");
  }
  if (!process.env.FAST2SMS_API_KEY) {
    console.warn("⚠️ SMS OTP is disabled: FAST2SMS_API_KEY missing.");
  }
});
