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
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

  // 🔹 Fix: replace escaped newlines with actual newlines
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
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
    const { amount, currency, customerId, paymentMethodId, tokenAmount, companyUUID } = req.body;

    if (!amount || !currency || !customerId || !paymentMethodId) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    // 🔹 Fetch the company's connected Stripe account
    let stripeAccountId = null;
    if (companyUUID) {
      const snapshot = await db.ref(`users/companies/${companyUUID}/companySettings/stripeAccountId`).once("value");
      stripeAccountId = snapshot.val();
    }

    const paymentIntentData = {
      amount,
      currency,
      customer: customerId,
      payment_method: paymentMethodId,
      confirm: true,
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: "never",
      },
    };

    // 🔹 If company has a connected account, route funds directly
    if (stripeAccountId) {
      paymentIntentData.transfer_data = {
        destination: stripeAccountId,
      };
    }

    const paymentIntent = await stripe.paymentIntents.create(paymentIntentData);

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
// ✅ Stripe Connect for Companies
// ----------------------------

// Step 1: Create or reuse Express onboarding link
app.post("/stripe/connect", async (req, res) => {
  try {
    const { companyUUID } = req.body;

    if (!companyUUID) {
      return res.status(400).json({ error: "Missing company UUID" });
    }

    // 🔹 Check if an account already exists
    const snapshot = await db.ref(`users/companies/${companyUUID}/companySettings/stripeAccountId`).once("value");
    let stripeAccountId = snapshot.val();

    if (!stripeAccountId) {
      // Create a new Stripe Connect account only if it doesn't exist
      const account = await stripe.accounts.create({
        type: "express",
        country: "US", // adjust if needed
        capabilities: {
          transfers: { requested: true },
        },
      });

      stripeAccountId = account.id;

      // Save accountId immediately to Firebase
      await db.ref(`users/companies/${companyUUID}/companySettings`).update({
        stripeAccountId,
      });
    }

    // Generate onboarding link for this account
    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
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

// Step 4: ✅ Check Stripe account status
app.get("/stripe/account-status/:companyUUID", async (req, res) => {
  try {
    const { companyUUID } = req.params;

    if (!companyUUID) {
      return res.status(400).json({ error: "Missing company UUID" });
    }

    // Fetch account ID from Firebase
    const snapshot = await db.ref(`users/companies/${companyUUID}/companySettings/stripeAccountId`).once("value");
    const stripeAccountId = snapshot.val();

    if (!stripeAccountId) {
      return res.status(404).json({ error: "No Stripe account linked" });
    }

    // Fetch account details from Stripe
    const account = await stripe.accounts.retrieve(stripeAccountId);

    res.json({
      accountId: account.id,
      email: account.email || null,
      businessType: account.business_type || null,
      capabilities: account.capabilities,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      requirements: account.requirements,
    });
  } catch (err) {
    console.error("❌ Error checking Stripe account status:", err.message);
    res.status(500).json({ error: err.message });
  }
});


// ----------------------------

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
