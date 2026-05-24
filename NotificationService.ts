/**
 * PropVoice NotificationService
 * Smart reminders for late rent, payment failures, anomalies, and job updates.
 * Currently logs to console — swap sendSMS/sendEmail bodies for Twilio/SendGrid.
 */

type Channel = 'SMS' | 'EMAIL' | 'PUSH';

interface Notification {
  channel: Channel;
  to: string;
  subject?: string;
  body: string;
}

async function sendSMS(to: string, body: string): Promise<void> {
  // TODO: Replace with Twilio
  // await twilioClient.messages.create({ from: process.env.TWILIO_PHONE, to, body });
  console.log(`[SMS → ${to}] ${body}`);
}

async function sendEmail(to: string, subject: string, body: string): Promise<void> {
  // TODO: Replace with SendGrid/Nodemailer
  console.log(`[EMAIL → ${to}] ${subject}: ${body}`);
}

async function dispatch(n: Notification): Promise<void> {
  try {
    if (n.channel === 'SMS') await sendSMS(n.to, n.body);
    if (n.channel === 'EMAIL') await sendEmail(n.to, n.subject ?? 'PropVoice Notification', n.body);
  } catch (err) {
    console.error(`[NotificationService] Failed to send ${n.channel} to ${n.to}:`, err);
  }
}

// ─── Rent Reminders ───────────────────────────────────────────────────────────

export async function notifyRentDueSoon(
  tenantEmail: string,
  tenantPhone: string | null,
  tenantName: string,
  amountEur: number,
  daysUntilDue: number
): Promise<void> {
  const body = `Hi ${tenantName}, your rent of €${amountEur} is due in ${daysUntilDue} day${daysUntilDue === 1 ? '' : 's'}. It will be collected automatically — no action needed. — PropVoice`;
  await dispatch({ channel: 'EMAIL', to: tenantEmail, subject: `Rent due in ${daysUntilDue} days`, body });
  if (tenantPhone) await dispatch({ channel: 'SMS', to: tenantPhone, body });
}

export async function notifyRentCollected(
  tenantEmail: string,
  tenantName: string,
  amountEur: number
): Promise<void> {
  await dispatch({
    channel: 'EMAIL',
    to: tenantEmail,
    subject: '✅ Rent payment confirmed',
    body: `Hi ${tenantName}, your rent payment of €${amountEur} was collected successfully. Thank you! — PropVoice`,
  });
}

export async function notifyRentFailed(
  tenantEmail: string,
  tenantPhone: string | null,
  tenantName: string,
  amountEur: number,
  retryDate: string
): Promise<void> {
  const body = `⚠️ ${tenantName}, your rent payment of €${amountEur} failed. We'll retry on ${retryDate}. Please check your payment method at propvoice.app — PropVoice`;
  await dispatch({ channel: 'EMAIL', to: tenantEmail, subject: '⚠️ Rent payment failed', body });
  if (tenantPhone) await dispatch({ channel: 'SMS', to: tenantPhone, body });
}

export async function notifyRentOverdue(
  tenantEmail: string,
  tenantPhone: string | null,
  tenantName: string,
  amountEur: number,
  daysOverdue: number
): Promise<void> {
  const body = `🔴 OVERDUE: ${tenantName}, your rent of €${amountEur} is ${daysOverdue} days overdue. Please update your payment method immediately to avoid late fees. — PropVoice`;
  await dispatch({ channel: 'EMAIL', to: tenantEmail, subject: '🔴 Rent payment overdue', body });
  if (tenantPhone) await dispatch({ channel: 'SMS', to: tenantPhone, body });
}

// ─── Landlord Alerts ──────────────────────────────────────────────────────────

export async function notifyLandlordRentReceived(
  landlordEmail: string,
  landlordName: string,
  tenantName: string,
  amountEur: number,
  unitAddress: string
): Promise<void> {
  await dispatch({
    channel: 'EMAIL',
    to: landlordEmail,
    subject: `✅ Rent received — ${unitAddress}`,
    body: `Hi ${landlordName}, rent of €${amountEur} from ${tenantName} at ${unitAddress} has been collected and is being disbursed to your account. — PropVoice`,
  });
}

export async function notifyLandlordEscrowHeld(
  landlordEmail: string,
  landlordName: string,
  amountEur: number,
  ticketId: string,
  serviceType: string
): Promise<void> {
  await dispatch({
    channel: 'EMAIL',
    to: landlordEmail,
    subject: `🔒 Escrow hold placed — ${serviceType}`,
    body: `Hi ${landlordName}, €${amountEur} has been held in escrow for ticket #${ticketId.slice(0, 8)} (${serviceType}). Funds will be released to the vendor once work is confirmed complete. — PropVoice`,
  });
}

export async function notifyLandlordPaymentAnomaly(
  landlordEmail: string,
  landlordName: string,
  anomaly: string
): Promise<void> {
  await dispatch({
    channel: 'EMAIL',
    to: landlordEmail,
    subject: '⚠️ Payment anomaly detected',
    body: `Hi ${landlordName}, PropVoice detected an unusual payment pattern: ${anomaly}. Please review your dashboard. — PropVoice`,
  });
}

// ─── Vendor Notifications ─────────────────────────────────────────────────────

export async function notifyVendorJobDispatched(
  vendorEmail: string,
  vendorPhone: string | null,
  vendorName: string,
  address: string,
  serviceType: string,
  amountEur: number
): Promise<void> {
  const body = `Hey ${vendorName}, new job: ${serviceType} at ${address}. Agreed: €${amountEur}. Funds secured in escrow. — PropVoice`;
  await dispatch({ channel: 'EMAIL', to: vendorEmail, subject: `New job: ${serviceType}`, body });
  if (vendorPhone) await dispatch({ channel: 'SMS', to: vendorPhone, body });
}

export async function notifyVendorPaid(
  vendorEmail: string,
  vendorPhone: string | null,
  vendorName: string,
  amountEur: number
): Promise<void> {
  const body = `✅ ${vendorName}, your payment of €${amountEur} has been transferred to your account. — PropVoice`;
  await dispatch({ channel: 'EMAIL', to: vendorEmail, subject: '✅ Payment sent', body });
  if (vendorPhone) await dispatch({ channel: 'SMS', to: vendorPhone, body });
}
