// server.js
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Simple health check for Render
app.get("/healthz", (req, res) => {
  res.send("OK");
});

// ✅ Example Stripe route (we’ll wire this properly later)
app.get("/api/hello", (req, res) => {
  res.json({ message: "BluCollarBookings backend is running!" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
