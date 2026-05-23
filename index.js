require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const app = express();

// ── CORS FIX ──
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, x-nowpayments-sig');
    if (req.method === 'OPTIONS') { return res.status(200).send('OK'); }
    next();
});
app.use('/webhook/nowpayments', express.raw({ type: 'application/json' }));
app.use(express.json());

const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY;
const NOWPAYMENTS_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(message) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
      }),
    });
  } catch (err) {
    console.error('[Telegram] Failed:', err.message);
  }
}

// ── KEEP ALIVE ──
app.get('/', (req, res) => {
  res.send('Cyrus NowPayments Webhook Running ✅');
});

// ── CREATE PAYMENT ──
app.post('/create-payment', async (req, res) => {
  try {
    const { amount, uid, email, pay_currency } = req.body;
    if (!amount || !uid) {
      return res.status(400).json({ error: 'Missing amount or uid' });
    }

    const response = await fetch('https://api.nowpayments.io/v1/payment', {
      method: 'POST',
      headers: {
        'x-api-key': NOWPAYMENTS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        price_amount: amount,
        price_currency: 'usd',
        pay_currency: 'sol',
        order_id: uid,
        order_description: `Cyrus Capital Deposit - ${email || uid}`,
        ipn_callback_url: `https://cyrus-nowpayments-webhook-production.up.railway.app/webhook/nowpayments`,
      }),
    });

    const data = await response.json();
    console.log('[CreatePayment] Response:', JSON.stringify(data));

    if (data.payment_id) {
      // Save to Firestore
      await db.collection('depositProofs').add({
        uid: uid,
        userEmail: email || '',
        paymentId: String(data.payment_id),
        amount: amount,
        status: 'pending',
        payAddress: data.pay_address,
        payCurrency: data.pay_currency,
        payAmount: data.pay_amount,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });

      return res.json({
        success: true,
        payment_id: data.payment_id,
        pay_address: data.pay_address,
        pay_amount: data.pay_amount,
        pay_currency: data.pay_currency,
      });
    } else {
      return res.status(500).json({ error: data.message || 'Payment creation failed' });
    }
  } catch (err) {
    console.error('[CreatePayment] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── WEBHOOK ──
app.post('/webhook/nowpayments', async (req, res) => {
  try {
    const rawBody = req.body;
    const data = JSON.parse(rawBody.toString());
    console.log('[Webhook] Received:', JSON.stringify(data));

    const paymentId = String(data.payment_id || '');
    const status = data.payment_status || '';
    const amountPaid = parseFloat(data.actually_paid || data.pay_amount || 0);
    const currency = data.pay_currency || '';
    const orderUid = data.order_id || '';

    if (status !== 'finished' && status !== 'confirmed') {
      console.log(`[Webhook] Status is "${status}", not ready yet.`);
      return res.status(200).send('OK - not ready');
    }

    if (!paymentId) return res.status(200).send('OK - no payment id');

    // Check already processed
    const alreadyDone = await db.collection('processed_nowpayments').doc(paymentId).get();
    if (alreadyDone.exists) return res.status(200).send('OK - already done');

    // Find deposit proof
    const proofSnap = await db.collection('depositProofs')
      .where('paymentId', '==', paymentId)
      .where('status', '==', 'pending')
      .limit(1)
      .get();

    let userUid = orderUid;
    let creditAmount = amountPaid;

    if (!proofSnap.empty) {
      const proofData = proofSnap.docs[0].data();
      userUid = proofData.uid || orderUid;
      creditAmount = proofData.amount || amountPaid;

      await proofSnap.docs[0].ref.update({
        status: 'approved',
        approvedAt: admin.firestore.Timestamp.now(),
        approvedBy: 'auto_nowpayments_webhook',
        actuallyPaid: amountPaid,
      });
    }

    if (!userUid) return res.status(200).send('OK - no user found');

    // Credit user
    const userRef = db.collection('users').doc(userUid);
    await userRef.update({
      balance: admin.firestore.FieldValue.increment(creditAmount),
    });

    // Add transaction
    await db.collection('transactions').add({
      uid: userUid,
      type: 'Deposit',
      amount: creditAmount,
      status: 'approved',
      timestamp: admin.firestore.Timestamp.now(),
      metadata: {
        paymentId: paymentId,
        currency: currency,
        actuallyPaid: amountPaid,
        autoApproved: true,
        source: 'NowPayments',
      },
    });

    // Mark processed
    await db.collection('processed_nowpayments').doc(paymentId).set({
      processedAt: admin.firestore.Timestamp.now(),
      userUid: userUid,
      amount: creditAmount,
    });

    const userSnap = await userRef.get();
    const userData = userSnap.data() || {};

    await sendTelegram(
      `✅ <b>NowPayments Auto-Approved!</b>\n` +
      `👤 User: ${userData.firstName || 'Unknown'}\n` +
      `📧 Email: ${userData.email || userUid}\n` +
      `💰 Credited: $${creditAmount}\n` +
      `🪙 Paid: ${amountPaid} ${currency}\n` +
      `🆔 Payment ID: ${paymentId}\n` +
      `⏰ Time: ${new Date().toLocaleString()}`
    );

    console.log(`[Webhook] ✅ Auto-credited $${creditAmount} to ${userUid}`);
    return res.status(200).send('OK - credited');

  } catch (err) {
    console.error('[Webhook] Error:', err.message);
    return res.status(500).send('Error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Cyrus] NowPayments webhook server running on port ${PORT}`);
});
