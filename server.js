// server.js
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import Stripe from "stripe";
import admin from "firebase-admin";

dotenv.config();

const app = express();
const port = process.env.PORT || 4242;

// -------------------------
// Stripe setup
// -------------------------
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  // apiVersion: "2024-06-20", // optional: pin a fixed version
});

// -------------------------
// Firebase Admin setup
// -------------------------
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DB_URL,
  });
}
const db = admin.database();

// ---------------------------------------------------
// (Optional) Stripe webhook (raw body, before JSON)
// ---------------------------------------------------
if (process.env.STRIPE_WEBHOOK_SECRET) {
  app.post(
    "/stripe/webhook",
    express.raw({ type: "application/json" }),
    (req, res) => {
      const sig = req.headers["stripe-signature"];
      try {
        const event = stripe.webhooks.constructEvent(
          req.body,
          sig,
          process.env.STRIPE_WEBHOOK_SECRET
        );
        // TODO: handle events (invoice.paid, invoice.payment_failed, etc.)
        res.json({ received: true });
      } catch (err) {
        console.error("Webhook verify failed:", err.message);
        res.status(400).send(`Webhook Error: ${err.message}`);
      }
    }
  );
}

// JSON middleware AFTER webhook
app.use(bodyParser.json());

// ---------------------------------------------------
// Health
// ---------------------------------------------------
app.get("/healthz", (_req, res) => {
  res.status(200).send("OK");
});

// ---------------------------------------------------
// Helpers
// ---------------------------------------------------
const SURCHARGE_LOW_PERCENT = 3;
const SURCHARGE_HIGH_PERCENT = 7;

function toCents(amount) {
  const n = typeof amount === "number" ? amount : parseFloat(String(amount || 0));
  return Math.round(n * 100);
}
function fmtDollarsFromCents(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

async function getStripeAccountId(companyUUID) {
  const snap = await db
    .ref(`users/companies/${companyUUID}/companySettings/stripeAccountId`)
    .once("value");
  return snap.val() || null;
}

async function getOrCreatePlatformCustomer(ticketRef, customer) {
  const platformIdSnap = await ticketRef
    .child("customerDetails/stripeCustomerIdPlatform")
    .once("value");
  const existing = platformIdSnap.val();
  if (existing) return existing;

  const created = await stripe.customers.create({
    email: customer?.email || undefined,
    name: `${customer?.firstName || ""} ${customer?.lastName || ""}`.trim() || undefined,
    phone: customer?.phone || undefined,
    metadata: { blucollar_ticket_id: ticketRef.key || "" },
  });
  await ticketRef.child("customerDetails/stripeCustomerIdPlatform").set(created.id);
  return created.id;
}

function companyTicketRef(companyUUID, ticketId) {
  return db.ref(`users/companies/${companyUUID}/ticketManager/activeServiceTickets/${ticketId}`);
}
function companyCompletedTicketRef(companyUUID, ticketId) {
  return db.ref(`users/companies/${companyUUID}/ticketManager/completedServiceTickets/${ticketId}`);
}
function customerTicketRef(customerUserId, ticketId) {
  return db.ref(`users/customers/${customerUserId}/ticketManager/${ticketId}`);
}

function hasActiveCardPayments(account) {
  return (
    account &&
    account.capabilities &&
    account.capabilities.card_payments === "active" &&
    account.charges_enabled === true
  );
}

// ---------------------------------------------------
// Payments
// ---------------------------------------------------
app.post("/create-payment-intent", async (req, res) => {
  try {
    const { amount, currency, customerId, paymentMethodId, tokenAmount, companyUUID } = req.body;
    if (!amount || !currency || !customerId || !paymentMethodId) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    let stripeAccountId = null;
    if (companyUUID) {
      stripeAccountId = await getStripeAccountId(companyUUID);
    }

    const params = {
      amount,
      currency,
      customer: customerId,
      payment_method: paymentMethodId,
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    };

    if (stripeAccountId) {
      params.transfer_data = { destination: stripeAccountId };
    }

    const pi = await stripe.paymentIntents.create(params);

    if (pi.status === "succeeded") {
      return res.json({
        clientSecret: pi.client_secret,
        status: pi.status,
        awardedTokens: tokenAmount || 0,
      });
    }

    res.json({ clientSecret: pi.client_secret, status: pi.status });
  } catch (err) {
    console.error("Stripe Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------
// Customers & Setup Intents
// ---------------------------------------------------
app.post("/create-stripe-customer", async (req, res) => {
  try {
    const { email, firstName, lastName } = req.body;
    if (!email) return res.status(400).json({ error: "Missing email" });

    const customer = await stripe.customers.create({
      email,
      name: `${firstName || ""} ${lastName || ""}`.trim(),
    });

    res.json({ customerId: customer.id });
  } catch (err) {
    console.error("Create customer:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/customer/:id/payment-methods", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "Missing customer ID" });

    const pms = await stripe.paymentMethods.list({ customer: id, type: "card" });
    res.json(pms.data);
  } catch (err) {
    console.error("List PMs:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/create-setup-intent", async (req, res) => {
  try {
    const { customerId } = req.body;
    if (!customerId) return res.status(400).json({ error: "Missing customer ID" });

    const si = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    });

    res.json({ clientSecret: si.client_secret });
  } catch (err) {
    console.error("Create setup intent:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------
// Stripe Connect (Option A + fallback helpers)
// ----------------------------
app.post("/stripe/connect", async (req, res) => {
  try {
    const { companyUUID } = req.body;
    if (!companyUUID) return res.status(400).json({ error: "Missing company UUID" });

    let stripeAccountId = await getStripeAccountId(companyUUID);

    if (!stripeAccountId) {
      // New Express account with both capabilities requested
      const account = await stripe.accounts.create({
        type: "express",
        country: "US",
        capabilities: {
          transfers: { requested: true },
          card_payments: { requested: true }, // ✅ request card payments
        },
      });
      stripeAccountId = account.id;

      await db.ref(`users/companies/${companyUUID}/companySettings`).update({
        stripeAccountId,
      });
    } else {
      // Ensure existing account requested card_payments if not already
      const acct = await stripe.accounts.retrieve(stripeAccountId);
      const cp =
        acct.capabilities?.card_payments === "active" ||
        acct.capabilities?.card_payments === "pending";
      if (!cp) {
        await stripe.accounts.update(stripeAccountId, {
          capabilities: { card_payments: { requested: true } },
        });
      }
    }

    // Always give back an onboarding link so they can complete requirements
    const link = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: `${process.env.BASE_URL}/stripe/connect/refresh?companyUUID=${companyUUID}`,
      return_url: `${process.env.BASE_URL}/stripe/connect/success?companyUUID=${companyUUID}`,
      type: "account_onboarding",
    });

    res.json({ url: link.url, accountId: stripeAccountId });
  } catch (err) {
    console.error("Connect error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Handy: generate an onboarding link again for an already-linked company
app.post("/stripe/connect/onboarding-link", async (req, res) => {
  try {
    const { companyUUID } = req.body;
    if (!companyUUID) return res.status(400).json({ error: "Missing company UUID" });

    const stripeAccountId = await getStripeAccountId(companyUUID);
    if (!stripeAccountId) return res.status(404).json({ error: "No Stripe account linked" });

    const link = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: `${process.env.BASE_URL}/stripe/connect/refresh?companyUUID=${companyUUID}`,
      return_url: `${process.env.BASE_URL}/stripe/connect/success?companyUUID=${companyUUID}`,
      type: "account_onboarding",
    });

    res.json({ url: link.url, accountId: stripeAccountId });
  } catch (err) {
    console.error("Onboarding link:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/stripe/connect/success", async (req, res) => {
  try {
    const { companyUUID } = req.query;
    res.send(`<h1>✅ Stripe Connect onboarding completed for ${companyUUID}</h1>`);
  } catch {
    res.status(500).send("❌ Error completing onboarding");
  }
});

app.get("/stripe/connect/refresh", async (_req, res) => {
  try {
    res.send("<h1>⚠️ Onboarding was interrupted. Please try again.</h1>");
  } catch {
    res.status(500).send("❌ Error refreshing onboarding");
  }
});

app.get("/stripe/account-status/:companyUUID", async (req, res) => {
  try {
    const { companyUUID } = req.params;
    if (!companyUUID) return res.status(400).json({ error: "Missing company UUID" });

    const stripeAccountId = await getStripeAccountId(companyUUID);
    if (!stripeAccountId) return res.status(404).json({ error: "No Stripe account linked" });

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
    console.error("Account status:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------
// Invoices with surcharge (Option A w/ fallback)
// ---------------------------------------------------
app.post("/invoices/create", async (req, res) => {
  try {
    const { ticketId, companyUUID, grandTotal, priority } = req.body;
    if (!ticketId || !companyUUID || !grandTotal) {
      return res.status(400).json({ error: "Missing ticketId, companyUUID, or grandTotal" });
    }

    const ticketRef = companyTicketRef(companyUUID, ticketId);
    const ticketSnap = await ticketRef.get();
    if (!ticketSnap.exists()) return res.status(404).json({ error: "Ticket not found" });

    const ticket = ticketSnap.val() || {};
    const customerDetails = ticket.customerDetails || {};
    const customerUserId = String(customerDetails.userId || "");

    // surcharge computation
    const p = String(priority || (ticket.ticketSettings?.priority ?? "Low")).toLowerCase();
    let percent = 0;
    if (p === "low") percent = SURCHARGE_LOW_PERCENT;
    if (p === "high") percent = SURCHARGE_HIGH_PERCENT;

    const totalCents = toCents(Number(grandTotal));
    const surchargeCents = Math.round((percent / 100) * totalCents);

    const stripeAccountId = await getStripeAccountId(companyUUID);
    if (!stripeAccountId) {
      return res.status(400).json({ error: "Company is not linked to Stripe Connect" });
    }

    const account = await stripe.accounts.retrieve(stripeAccountId);
    const canUseOnBehalfOf = hasActiveCardPayments(account);

    // Ensure platform customer
    const platformCustomerId = await getOrCreatePlatformCustomer(ticketRef, {
      email: customerDetails.email,
      firstName: customerDetails.firstName,
      lastName: customerDetails.lastName,
      phone: customerDetails.phone,
    });

    const surchargeLabel = `BluCollarBookings Service Charge (${percent}% = ${fmtDollarsFromCents(
      surchargeCents
    )})`;
    const invoiceDesc = `Invoice for Ticket #${ticketId} • ${surchargeLabel}`;

    // Base invoice params
    const invoiceParams = {
      customer: platformCustomerId,
      collection_method: "send_invoice",
      days_until_due: 3,
      description: invoiceDesc,
      transfer_data: { destination: stripeAccountId },
      application_fee_amount: surchargeCents > 0 ? surchargeCents : undefined,
      metadata: {
        blucollar_ticket_id: ticketId,
        company_uuid: companyUUID,
        priority: p,
        surcharge_percent: String(percent),
        surcharge_cents: String(surchargeCents),
        grand_total_cents: String(totalCents),
        fallback_used: String(!canUseOnBehalfOf),
      },
      footer: `Ticket #${ticketId} • Includes ${surchargeLabel} collected by BluCollarBookings (platform fee).`,
    };

    // ✅ Use on_behalf_of only when capability is active; else fall back
    if (canUseOnBehalfOf) {
      invoiceParams.on_behalf_of = stripeAccountId;
    } else {
      console.warn(
        `Company ${companyUUID} lacks active card_payments; creating invoice without on_behalf_of (fallback).`
      );
    }

    const invoice = await stripe.invoices.create(invoiceParams);

    await stripe.invoiceItems.create({
      customer: platformCustomerId,
      invoice: invoice.id,
      amount: totalCents,
      currency: "usd",
      description: `Service Balance • Ticket #${ticketId} • Priority: ${p} • ${surchargeLabel}`,
      metadata: { blucollar_ticket_id: ticketId, priority: p, surcharge_cents: String(surchargeCents) },
    });

    const finalized = await stripe.invoices.finalizeInvoice(invoice.id);

    const hostedUrl = finalized.hosted_invoice_url || "";
    const status = finalized.status || "draft";
    const amountDueCents = finalized.amount_due ?? 0;
    const amountDueDollars = (amountDueCents / 100).toFixed(2);
    const dueDate = finalized.due_date || null;

    // Save to company ticket
    await ticketRef.child("invoices").set({
      invoiceId: finalized.id,
      hostedInvoiceUrl: hostedUrl,
      status,
      amountDueCents,
      amountDue: amountDueDollars,
      createdAt: new Date().toISOString(),
      dueDate,
      surcharge: {
        priority: p,
        percent: percent / 100,
        surchargeCents,
        surchargeDollars: (surchargeCents / 100).toFixed(2),
        collectedBy: "BluCollarBookings",
        platformInvoice: true,
      },
      metadata: { ticketId, companyUUID, grandTotalCents: totalCents },
      display: {
        title: `Invoice for Ticket #${ticketId} (${fmtDollarsFromCents(totalCents)})`,
        note: surchargeLabel,
      },
    });

    // Mirror to customer + mark completed
    if (customerUserId) {
      const cRef = customerTicketRef(customerUserId, ticketId);
      await cRef.child("invoices").set({
        invoiceId: finalized.id,
        hostedInvoiceUrl: hostedUrl,
        status,
        amountDueCents,
        amountDue: amountDueDollars,
        createdAt: new Date().toISOString(),
        dueDate,
        surcharge: {
          priority: p,
          percent: percent / 100,
          surchargeCents,
          surchargeDollars: (surchargeCents / 100).toFixed(2),
          collectedBy: "BluCollarBookings",
          platformInvoice: true,
        },
        metadata: { ticketId, companyUUID, grandTotalCents: totalCents },
      });
      await cRef.child("ticketSettings").update({ BookingStatus: "Completed Booking" });
    }

    // Move company ticket Active -> Completed
    await ticketRef.child("ticketSettings").update({ BookingStatus: "Completed Booking" });
    const activeSnap = await ticketRef.get();
    if (activeSnap.exists()) {
      await companyCompletedTicketRef(companyUUID, ticketId).set(activeSnap.val());
      await ticketRef.remove();
    }

    res.json({
      invoiceId: finalized.id,
      hostedInvoiceUrl: hostedUrl,
      status,
      amountDueCents,
      amountDue: amountDueDollars,
      dueDate,
    });
  } catch (err) {
    console.error("/invoices/create error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
