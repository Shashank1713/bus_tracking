const express = require("express");
const http = require("http");

const app = express();
const server = http.createServer(app);
const io = require("socket.io")(server);

app.use(express.static("public"));

const buses = {};

io.on("connection", socket => {
  console.log("Client connected");

  socket.on("location", data => {
    buses[data.mobile] = { ...data, time: Date.now() };
    io.emit("location", data);
    io.emit("busList", buses);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on http://localhost:" + PORT);
});
