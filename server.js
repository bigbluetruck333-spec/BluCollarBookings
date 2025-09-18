// server.js
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import Stripe from "stripe";

dotenv.config();

const app = express();
const port = process.env.PORT || 4242;

// ✅ Stripe setup
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2025-01-27.acacia", // use the latest
});

app.use(bodyParser.json());

// Health check
app.get("/healthz", (req, res) => {
  res.status(200).send("OK");
});

// ✅ Create PaymentIntent route
app.post("/create-payment-intent", async (req, res) => {
  try {
    const { amount, currency, customerId, paymentMethodId } = req.body;

    if (!amount || !currency) {
      return res.status(400).json({ error: "Missing amount or currency" });
    }
    if (!customerId) {
      return res.status(400).json({ error: "Missing customerId" });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      customer: customerId,                     // 👈 attach customer
      payment_method: paymentMethodId || null,  // 👈 optional: saved card
      automatic_payment_methods: { enabled: !paymentMethodId }, // if no saved card
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error("❌ Stripe Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});


// ✅ Create Stripe customer
app.post("/create-stripe-customer", async (req, res) => {
  try {
    const { email, firstName, lastName } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Missing email" });
    }

    const customer = await stripe.customers.create({
      email,
      name: `${firstName || ""} ${lastName || ""}`.trim(),
    });

    res.json({ customerId: customer.id });
  } catch (err) {
    console.error("❌ Error creating Stripe customer:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Fetch saved payment methods for a customer
app.get("/customer/:id/payment-methods", async (req, res) => {
  try {
    const { id } = req.params; // Stripe customer ID (cus_xxx)

    if (!id) {
      return res.status(400).json({ error: "Missing customer ID" });
    }

    const paymentMethods = await stripe.paymentMethods.list({
      customer: id,
      type: "card",
    });

    res.json(paymentMethods.data);
  } catch (err) {
    console.error("❌ Error fetching payment methods:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Create SetupIntent (for adding a new card)
app.post("/create-setup-intent", async (req, res) => {
  try {
    const { customerId } = req.body;

    if (!customerId) {
      return res.status(400).json({ error: "Missing customer ID" });
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
    });

    res.json({ clientSecret: setupIntent.client_secret });
  } catch (err) {
    console.error("❌ Error creating SetupIntent:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
