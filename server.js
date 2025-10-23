import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import Stripe from "stripe";
import admin from "firebase-admin"; // ✅ Firebase Admin SDK

dotenv.config();

const app = express();
const port = process.env.PORT || 4242;

// ✅ Stripe setup
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: "2025-01-27.acacia", // use the latest
});

// ✅ Firebase setup
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT as string);

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

// ---------------------------------------------------
// Health check
// ---------------------------------------------------
app.get("/healthz", (_req, res) => {
  res.status(200).send("OK");
});

// ---------------------------------------------------
// Helpers (added)
// ---------------------------------------------------
const SURCHARGE_LOW_PERCENT = 3;   // keep hardcoded per your choice
const SURCHARGE_HIGH_PERCENT = 7;

function toCents(amount: number | string): number {
  const n = typeof amount === "number" ? amount : parseFloat(String(amount));
  return Math.round(n * 100);
}
function fmtDollarsFromCents(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

// Fetch connected account id for a company
async function getStripeAccountId(companyUUID: string): Promise<string | null> {
  const snap = await db
    .ref(`users/companies/${companyUUID}/companySettings/stripeAccountId`)
    .once("value");
  return snap.val() || null;
}

// Ensure a **platform** customer exists for invoice creation on platform
async function getOrCreatePlatformCustomer(
  ticketRef: admin.database.Reference,
  customer: { email?: string; firstName?: string; lastName?: string; phone?: string }
): Promise<string> {
  const platformIdSnap = await ticketRef.child("customerDetails/stripeCustomerIdPlatform").once("value");
  const existing = platformIdSnap.val();
  if (existing) return existing;

  const created = await stripe.customers.create({
    email: customer.email || undefined,
    name: `${customer.firstName || ""} ${customer.lastName || ""}`.trim() || undefined,
    phone: customer.phone || undefined,
    metadata: {
      blucollar_ticket_id: ticketRef.key || "",
    },
  });
  await ticketRef.child("customerDetails/stripeCustomerIdPlatform").set(created.id);
  return created.id;
}

// Convenience: Firebase paths for company/customer tickets
function companyTicketRef(companyUUID: string, ticketId: string) {
  return db.ref(`users/companies/${companyUUID}/ticketManager/activeServiceTickets/${ticketId}`);
}
function companyCompletedTicketRef(companyUUID: string, ticketId: string) {
  return db.ref(`users/companies/${companyUUID}/ticketManager/completedServiceTickets/${ticketId}`);
}
function customerTicketRef(customerUserId: string, ticketId: string) {
  return db.ref(`users/customers/${customerUserId}/ticketManager/${ticketId}`);
}

// ---------------------------------------------------
// Existing routes (unchanged)
// ---------------------------------------------------

// ✅ Create PaymentIntent route
app.post("/create-payment-intent", async (req, res) => {
  try {
    const { amount, currency, customerId, paymentMethodId, tokenAmount, companyUUID } = req.body;

    if (!amount || !currency || !customerId || !paymentMethodId) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    // 🔹 Fetch the company's connected Stripe account
    let stripeAccountId: string | null = null;
    if (companyUUID) {
      stripeAccountId = await getStripeAccountId(companyUUID);
    }

    const paymentIntentData: Stripe.PaymentIntentCreateParams = {
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
      (paymentIntentData as any).transfer_data = { destination: stripeAccountId };
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
  } catch (err: any) {
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
  } catch (err: any) {
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
  } catch (err: any) {
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
  } catch (err: any) {
    console.error("❌ Error creating SetupIntent:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------
// ✅ Stripe Connect for Companies (unchanged)
// ----------------------------
app.post("/stripe/connect", async (req, res) => {
  try {
    const { companyUUID } = req.body;

    if (!companyUUID) {
      return res.status(400).json({ error: "Missing company UUID" });
    }

    // 🔹 Check if an account already exists
    const stripeAccountIdExisting = await getStripeAccountId(companyUUID);
    let stripeAccountId = stripeAccountIdExisting;

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
      account: stripeAccountId!,
      refresh_url: `${process.env.BASE_URL}/stripe/connect/refresh?companyUUID=${companyUUID}`,
      return_url: `${process.env.BASE_URL}/stripe/connect/success?companyUUID=${companyUUID}`,
      type: "account_onboarding",
    });

    res.json({ url: accountLink.url });
  } catch (err: any) {
    console.error("❌ Error creating Stripe Connect account:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/stripe/connect/success", async (req, res) => {
  try {
    const { companyUUID } = req.query;
    res.send(`<h1>✅ Stripe Connect onboarding completed for ${companyUUID}</h1>`);
  } catch (_err) {
    res.status(500).send("❌ Error completing onboarding");
  }
});

app.get("/stripe/connect/refresh", async (_req, res) => {
  try {
    res.send("<h1>⚠️ Onboarding was interrupted. Please try again.</h1>");
  } catch (_err) {
    res.status(500).send("❌ Error refreshing onboarding");
  }
});

app.get("/stripe/account-status/:companyUUID", async (req, res) => {
  try {
    const { companyUUID } = req.params;

    if (!companyUUID) {
      return res.status(400).json({ error: "Missing company UUID" });
    }

    // Fetch account ID from Firebase
    const stripeAccountId = await getStripeAccountId(companyUUID);
    if (!stripeAccountId) {
      return res.status(404).json({ error: "No Stripe account linked" });
    }

    // Fetch account details from Stripe
    const account = await stripe.accounts.retrieve(stripeAccountId);

    res.json({
      accountId: account.id,
      email: (account as any).email || null,
      businessType: (account as any).business_type || null,
      capabilities: account.capabilities,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      requirements: account.requirements,
    });
  } catch (err: any) {
    console.error("❌ Error checking Stripe account status:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------
// ✅ NEW: Create Invoice with surcharge + ticket metadata
// ---------------------------------------------------
app.post("/invoices/create", async (req, res) => {
  try {
    const { ticketId, companyUUID, grandTotal, priority } = req.body;

    if (!ticketId || !companyUUID || !grandTotal) {
      return res.status(400).json({ error: "Missing ticketId, companyUUID, or grandTotal" });
    }

    const ticketRef = companyTicketRef(companyUUID, ticketId);
    const ticketSnap = await ticketRef.get();
    if (!ticketSnap.exists()) {
      return res.status(404).json({ error: "Ticket not found" });
    }

    const ticket = ticketSnap.val() || {};
    const customerDetails = ticket.customerDetails || {};
    const customerUserId = String(customerDetails.userId || "");

    // Compute surcharge percent based on priority (default Low)
    const p = (priority || (ticket.ticketSettings?.priority ?? "Low")).toString().toLowerCase();
    let percent = 0;
    if (p === "low") percent = SURCHARGE_LOW_PERCENT;
    if (p === "high") percent = SURCHARGE_HIGH_PERCENT;

    const totalCents = toCents(Number(grandTotal));
    const surchargeCents = Math.round((percent / 100) * totalCents);

    // Get connected account id for company
    const stripeAccountId = await getStripeAccountId(companyUUID);
    if (!stripeAccountId) {
      return res.status(400).json({ error: "Company is not linked to Stripe Connect" });
    }

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

    // 1) Create invoice on PLATFORM with on_behalf_of + transfer destination + app fee
    const invoice = await stripe.invoices.create({
      customer: platformCustomerId,
      collection_method: "send_invoice",
      days_until_due: 3,
      description: invoiceDesc,
      on_behalf_of: stripeAccountId,
      transfer_data: { destination: stripeAccountId },
      application_fee_amount: surchargeCents > 0 ? surchargeCents : undefined,
      metadata: {
        blucollar_ticket_id: ticketId,
        company_uuid: companyUUID,
        priority: p,
        surcharge_percent: String(percent),
        surcharge_cents: String(surchargeCents),
        grand_total_cents: String(totalCents),
      },
      footer: `Ticket #${ticketId} • Includes ${surchargeLabel} collected by BluCollarBookings (platform fee).`,
    });

    // 2) Add line item for the total
    await stripe.invoiceItems.create({
      customer: platformCustomerId,
      invoice: invoice.id,
      amount: totalCents,
      currency: "usd",
      description: `Service Balance • Ticket #${ticketId} • Priority: ${p} • ${surchargeLabel}`,
      metadata: {
        blucollar_ticket_id: ticketId,
        priority: p,
        surcharge_cents: String(surchargeCents),
      },
    });

    // 3) Finalize
    const finalized = await stripe.invoices.finalizeInvoice(invoice.id);

    const hostedUrl = finalized.hosted_invoice_url || "";
    const status = finalized.status || "draft";
    const amountDueCents = (finalized.amount_due ?? 0) as number;
    const amountDueDollars = (amountDueCents / 100).toFixed(2);
    const dueDate = finalized.due_date || null;

    // Save on company ticket
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
        percent: percent / 100, // store as 0.03 or 0.07 (matches your app)
        surchargeCents,
        surchargeDollars: (surchargeCents / 100).toFixed(2),
        collectedBy: "BluCollarBookings",
        platformInvoice: true,
      },
      metadata: {
        ticketId,
        companyUUID,
        grandTotalCents: totalCents,
      },
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
        metadata: {
          ticketId,
          companyUUID,
          grandTotalCents: totalCents,
        },
      });
      await cRef.child("ticketSettings").update({ BookingStatus: "Completed Booking" });
    }

    // Company-side BookingStatus + move Active → Completed
    await ticketRef.child("ticketSettings").update({ BookingStatus: "Completed Booking" });

    const activeSnap = await ticketRef.get();
    if (activeSnap.exists()) {
      await companyCompletedTicketRef(companyUUID, ticketId).set(activeSnap.val());
      await ticketRef.remove();
    }

    return res.json({
      invoiceId: finalized.id,
      hostedInvoiceUrl: hostedUrl,
      status,
      amountDueCents,
      amountDue: amountDueDollars,
      dueDate,
    });
  } catch (err: any) {
    console.error("❌ /invoices/create error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------
// (Optional) Webhook stub for later
// ---------------------------------------------------
if (process.env.STRIPE_WEBHOOK_SECRET) {
  // Use raw body for Stripe signature verification
  app.post(
    "/stripe/webhook",
    express.raw({ type: "application/json" }) as any,
    (req, res) => {
      const sig = req.headers["stripe-signature"] as string;
      try {
        const event = stripe.webhooks.constructEvent(
          (req as any).body,
          sig,
          process.env.STRIPE_WEBHOOK_SECRET as string
        );

        // TODO: handle invoice.paid, invoice.payment_failed, etc.
        // console.log("🔔 Webhook event:", event.type);

        res.json({ received: true });
      } catch (err: any) {
        console.error("❌ Webhook signature verification failed:", err.message);
        res.status(400).send(`Webhook Error: ${err.message}`);
      }
    }
  );
}

// ----------------------------
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
