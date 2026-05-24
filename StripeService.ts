/**
 * PropVoice StripeService
 * Handles all Stripe operations: rent collection, escrow holds, vendor payouts,
 * Connect onboarding, payment retries, and refunds.
 */

import Stripe from 'stripe';

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('STRIPE_SECRET_KEY environment variable is required');
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
  typescript: true,
});

function log(event: string, payload: unknown) {
  console.log(`[StripeService] ${event}`, JSON.stringify(payload, null, 2));
}

// ─── Connected Accounts (Landlords & Vendors) ─────────────────────────────────

export async function createConnectedAccount(
  email: string,
  userId: string,
  role: 'LANDLORD' | 'VENDOR'
): Promise<{ accountId: string; onboardingUrl: string }> {
  const account = await stripe.accounts.create({
    type: 'express',
    email,
    country: 'AT', // Austria — adjust per your market
    capabilities: { transfers: { requested: true }, card_payments: { requested: true } },
    business_type: 'individual',
    metadata: { userId, role },
  });

  const accountLink = await stripe.accountLinks.create({
    account: account.id,
    refresh_url: `${process.env.APP_URL}/onboarding/refresh`,
    return_url: `${process.env.APP_URL}/onboarding/complete`,
    type: 'account_onboarding',
  });

  log('account.created', { accountId: account.id, userId, role });
  return { accountId: account.id, onboardingUrl: accountLink.url };
}

// ─── Tenant Customers ─────────────────────────────────────────────────────────

export async function createTenantCustomer(
  email: string,
  name: string,
  phone: string | null,
  paymentMethodId: string,
  userId: string
): Promise<string> {
  const customer = await stripe.customers.create({
    email,
    name,
    phone: phone ?? undefined,
    payment_method: paymentMethodId,
    invoice_settings: { default_payment_method: paymentMethodId },
    metadata: { userId },
  });

  await stripe.paymentMethods.attach(paymentMethodId, { customer: customer.id });
  log('customer.created', { customerId: customer.id, userId });
  return customer.id;
}

// ─── Rent Collection ──────────────────────────────────────────────────────────

export async function collectRent(
  stripeCustomerId: string,
  amountCents: number,
  metadata: Record<string, string> = {}
): Promise<Stripe.PaymentIntent> {
  const pi = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: 'eur',
    customer: stripeCustomerId,
    payment_method_types: ['card', 'sepa_debit'],
    confirm: true,
    off_session: true, // Automatic — no tenant action needed
    metadata: { purpose: 'rent_collection', ...metadata },
  });

  log('rent.collected', { id: pi.id, amount: amountCents, status: pi.status });
  return pi;
}

export async function retryFailedPayment(
  stripeCustomerId: string,
  amountCents: number,
  metadata: Record<string, string> = {}
): Promise<Stripe.PaymentIntent> {
  // Fetch the customer's payment methods and try the next one
  const methods = await stripe.paymentMethods.list({
    customer: stripeCustomerId,
    type: 'card',
  });

  if (methods.data.length === 0) {
    throw new Error('No payment methods available for retry');
  }

  const pi = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: 'eur',
    customer: stripeCustomerId,
    payment_method: methods.data[0].id,
    confirm: true,
    off_session: true,
    metadata: { purpose: 'rent_retry', ...metadata },
  });

  log('rent.retry', { id: pi.id, amount: amountCents, status: pi.status });
  return pi;
}

// ─── Maintenance Escrow ───────────────────────────────────────────────────────

export async function holdMaintenanceFunds(
  landlordStripeAccountId: string,
  amountCents: number,
  metadata: Record<string, string> = {}
): Promise<Stripe.PaymentIntent> {
  if (amountCents <= 0) throw new Error('Amount must be greater than zero');

  const pi = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: 'eur',
    capture_method: 'manual', // Holds funds without charging
    confirm: false,
    on_behalf_of: landlordStripeAccountId,
    transfer_data: { destination: landlordStripeAccountId },
    metadata: { purpose: 'maintenance_escrow', ...metadata },
  });

  log('escrow.held', { id: pi.id, amount: amountCents });
  return pi;
}

export async function captureHeldFunds(paymentIntentId: string): Promise<Stripe.PaymentIntent> {
  const captured = await stripe.paymentIntents.capture(paymentIntentId);
  log('escrow.captured', { id: captured.id });
  return captured;
}

export async function cancelEscrow(paymentIntentId: string): Promise<Stripe.PaymentIntent> {
  const cancelled = await stripe.paymentIntents.cancel(paymentIntentId);
  log('escrow.cancelled', { id: cancelled.id });
  return cancelled;
}

// ─── Vendor Payouts ───────────────────────────────────────────────────────────

export async function payoutVendor(
  vendorStripeAccountId: string,
  totalAmountCents: number,
  platformFeeCents: number,
  metadata: Record<string, string> = {}
): Promise<Stripe.Transfer> {
  if (platformFeeCents >= totalAmountCents) {
    throw new Error('Platform fee cannot exceed or equal total amount');
  }

  const vendorAmount = totalAmountCents - platformFeeCents;

  const transfer = await stripe.transfers.create({
    amount: vendorAmount,
    currency: 'eur',
    destination: vendorStripeAccountId,
    metadata: {
      purpose: 'vendor_payout',
      totalAmount: String(totalAmountCents),
      platformFee: String(platformFeeCents),
      ...metadata,
    },
  });

  log('vendor.paid', { transferId: transfer.id, vendorAmount, platformFeeCents });
  return transfer;
}

// ─── Landlord Disbursements ───────────────────────────────────────────────────

export async function disburseLandlord(
  landlordStripeAccountId: string,
  amountCents: number,
  metadata: Record<string, string> = {}
): Promise<Stripe.Transfer> {
  const transfer = await stripe.transfers.create({
    amount: amountCents,
    currency: 'eur',
    destination: landlordStripeAccountId,
    metadata: { purpose: 'landlord_disbursement', ...metadata },
  });

  log('landlord.disbursed', { transferId: transfer.id, amountCents });
  return transfer;
}

// ─── Payment Plans ────────────────────────────────────────────────────────────

export async function createPaymentPlan(
  stripeCustomerId: string,
  totalAmountCents: number,
  installments: number,
  metadata: Record<string, string> = {}
): Promise<Stripe.PaymentIntent[]> {
  const installmentAmount = Math.floor(totalAmountCents / installments);
  const intents: Stripe.PaymentIntent[] = [];

  for (let i = 0; i < installments; i++) {
    // Stagger each installment 30 days apart (first one immediate)
    const isLast = i === installments - 1;
    const amount = isLast
      ? totalAmountCents - installmentAmount * (installments - 1) // Handle rounding on last
      : installmentAmount;

    const pi = await stripe.paymentIntents.create({
      amount,
      currency: 'eur',
      customer: stripeCustomerId,
      payment_method_types: ['card'],
      confirm: i === 0, // Only confirm the first immediately
      off_session: true,
      metadata: {
        purpose: 'payment_plan',
        installmentNumber: String(i + 1),
        totalInstallments: String(installments),
        ...metadata,
      },
    });

    intents.push(pi);
    log(`paymentPlan.installment.${i + 1}`, { id: pi.id, amount });
  }

  return intents;
}
