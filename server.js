const express = require("express");
const path = require("path");
const cors = require("cors");

const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------------- AUTH (IN-MEMORY) ----------------
let users = {}; // { username: { password, role } }

app.post("/api/signup", (req, res) => {
    const { username, password, role } = req.body;

    if (!username || !password || !role) {
        return res.status(400).json({ message: "All fields required" });
    }
    if (users[username]) {
        return res.status(409).json({ message: "User already exists" });
    }

    users[username] = { password, role };
    res.json({ message: "Signup successful" });
});

app.post("/api/signin", (req, res) => {
    const { username, password } = req.body;
    const user = users[username];

    if (!user || user.password !== password) {
        return res.status(401).json({ message: "Invalid credentials" });
    }

    res.json({ username, role: user.role });
});

// ---------------- BUS TRACKING ----------------
let buses = {};

io.on("connection", socket => {
    socket.on("busLocation", data => {
        buses[data.busId] = {
            lat: data.lat,
            lon: data.lon,
            time: Date.now()
        };
        io.emit("fleetUpdate", buses);
    });
});

// Remove inactive buses
setInterval(() => {
    const now = Date.now();
    for (let id in buses) {
        if (now - buses[id].time > 30000) {
            delete buses[id];
        }
    }
}, 10000);

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});
