// server.js
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import Stripe from "stripe";
import admin from "firebase-admin"; // ✅ Firebase Admin SDK

dotenv.config();

const app = express();
const port = process.env.PORT || 4242;

// ✅ Stripe setup
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2025-01-27.acacia", // use the latest
});

// ✅ Firebase setup
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: process.env.FIREBASE_DB_URL,
  });
}
const db = admin.database();

app.use(bodyParser.json());

// Health check
app.get("/healthz", (req, res) => {
  res.status(200).send("OK");
});

// ✅ Create PaymentIntent route
app.post("/create-payment-intent", async (req, res) => {
  try {
    const { amount, currency, customerId, paymentMethodId, tokenAmount } = req.body;

    if (!amount || !currency || !customerId || !paymentMethodId) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      customer: customerId,
      payment_method: paymentMethodId,
      confirm: true,
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: "never",
      },
    });

    if (paymentIntent.status === "succeeded") {
      return res.json({
        clientSecret: paymentIntent.client_secret,
        status: paymentIntent.status,
        awardedTokens: tokenAmount || 0,
      });
    }

    res.json({
      clientSecret: paymentIntent.client_secret,
      status: paymentIntent.status,
    });
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
    const { id } = req.params;

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

// ✅ Create SetupIntent
app.post("/create-setup-intent", async (req, res) => {
  try {
    const { customerId } = req.body;

    if (!customerId) {
      return res.status(400).json({ error: "Missing customer ID" });
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: "never",
      },
    });

    res.json({ clientSecret: setupIntent.client_secret });
  } catch (err) {
    console.error("❌ Error creating SetupIntent:", err.message);
    res.status(500).json({ error: err.message });
  }
});


// ----------------------------
// ✅ NEW: Stripe Connect for Companies
// ----------------------------

// Step 1: Create Express onboarding link
app.post("/stripe/connect", async (req, res) => {
  try {
    const { companyUUID } = req.body;

    if (!companyUUID) {
      return res.status(400).json({ error: "Missing company UUID" });
    }

    // Create a new Stripe Connect account
    const account = await stripe.accounts.create({
      type: "express",
      country: "US", // adjust if needed
      capabilities: {
        transfers: { requested: true },
      },
    });

    // Save accountId immediately to Firebase
    await db.ref(`users/companies/${companyUUID}/companySettings`).update({
      stripeAccountId: account.id,
    });

    // Generate onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: `${process.env.BASE_URL}/stripe/connect/refresh?companyUUID=${companyUUID}`,
      return_url: `${process.env.BASE_URL}/stripe/connect/success?companyUUID=${companyUUID}`,
      type: "account_onboarding",
    });

    res.json({ url: accountLink.url });
  } catch (err) {
    console.error("❌ Error creating Stripe Connect account:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Step 2: Success endpoint (after onboarding)
app.get("/stripe/connect/success", async (req, res) => {
  try {
    const { companyUUID } = req.query;
    res.send(`<h1>✅ Stripe Connect onboarding completed for ${companyUUID}</h1>`);
  } catch (err) {
    res.status(500).send("❌ Error completing onboarding");
  }
});

// Step 3: Refresh endpoint (if onboarding interrupted)
app.get("/stripe/connect/refresh", async (req, res) => {
  try {
    res.send("<h1>⚠️ Onboarding was interrupted. Please try again.</h1>");
  } catch (err) {
    res.status(500).send("❌ Error refreshing onboarding");
  }
});


// ----------------------------

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
