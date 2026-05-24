/**
 * PropVoice MaintenanceManager
 * Orchestrates the full vendor job lifecycle:
 *   autoDispatchTicket → authorizeJobCost → finalizeAndPayJob
 */

import { PrismaClient, TransactionType, TransactionStatus, ServiceCategory } from '@prisma/client';
import * as StripeService from './StripeService.js';
import * as Notify from './NotificationService.js';

const prisma = new PrismaClient();

const PLATFORM_FEE_RATE = 0.10; // 10% on maintenance

const CATEGORY_MAP: Record<string, ServiceCategory> = {
  plumbing: 'PLUMBING',
  plumber: 'PLUMBING',
  cleaning: 'CLEANING',
  cleaner: 'CLEANING',
  heating: 'HEATING',
  hvac: 'HEATING',
  appliance: 'APPLIANCES',
  appliances: 'APPLIANCES',
  painting: 'PAINTING',
  painter: 'PAINTING',
  electrical: 'ELECTRICAL',
  electric: 'ELECTRICAL',
};

export async function autoDispatchTicket(ticketId: string, parsedCategory: string) {
  const normalized = CATEGORY_MAP[parsedCategory.toLowerCase()];
  if (!normalized) throw new Error(`Unknown service category: ${parsedCategory}`);

  const ticket = await prisma.serviceTicket.findUnique({
    where: { id: ticketId },
    include: { apartment: { include: { property: true } } },
  });
  if (!ticket) throw new Error(`Ticket ${ticketId} not found`);

  // Find an available vendor matching the category
  const vendor = await prisma.user.findFirst({
    where: {
      role: 'VENDOR',
      isOnboardingDone: true,
      stripeAccountId: { not: null },
    },
  });

  if (!vendor) throw new Error(`No available vendor for category: ${normalized}`);

  const updated = await prisma.serviceTicket.update({
    where: { id: ticketId },
    data: { vendorId: vendor.id, status: 'DISPATCHED', category: normalized },
  });

  await Notify.notifyVendorJobDispatched(
    vendor.email,
    vendor.phone ?? null,
    vendor.name,
    ticket.apartment.property.address,
    normalized,
    0 // Amount TBD until quote
  );

  return { ticketId: updated.id, vendor: { id: vendor.id, name: vendor.name, phone: vendor.phone, email: vendor.email } };
}

export async function authorizeJobCost(ticketId: string, quotedAmount: number) {
  const ticket = await prisma.serviceTicket.findUnique({
    where: { id: ticketId },
    include: { apartment: { include: { property: { include: { landlord: true } } } }, vendor: true },
  });
  if (!ticket) throw new Error(`Ticket ${ticketId} not found`);
  if (!ticket.apartment.property.landlord.stripeAccountId) throw new Error('Landlord has no Stripe account');

  const amountCents = Math.round(quotedAmount * 100);

  const pi = await StripeService.holdMaintenanceFunds(
    ticket.apartment.property.landlord.stripeAccountId,
    amountCents,
    { ticketId }
  );

  const tx = await prisma.transaction.create({
    data: {
      userId: ticket.apartment.property.landlordId,
      ticketId,
      type: TransactionType.VENDOR_ESCROW_HOLD,
      status: TransactionStatus.IN_ESCROW,
      amount: amountCents,
      stripePaymentIntentId: pi.id,
    },
  });

  await prisma.serviceTicket.update({
    where: { id: ticketId },
    data: { status: 'WORK_IN_PROGRESS', quotedAmount: amountCents },
  });

  const landlord = ticket.apartment.property.landlord;
  await Notify.notifyLandlordEscrowHeld(
    landlord.email,
    landlord.name,
    quotedAmount,
    ticketId,
    ticket.category
  );

  return { ticketId, transactionId: tx.id, paymentIntentId: pi.id, amountHeld: amountCents };
}

export async function finalizeAndPayJob(ticketId: string) {
  const ticket = await prisma.serviceTicket.findUnique({
    where: { id: ticketId },
    include: {
      vendor: true,
      transactions: { where: { type: 'VENDOR_ESCROW_HOLD', status: 'IN_ESCROW' } },
    },
  });
  if (!ticket) throw new Error(`Ticket ${ticketId} not found`);
  if (!ticket.vendor?.stripeAccountId) throw new Error('Vendor missing Stripe account');

  const escrowTx = ticket.transactions[0];
  if (!escrowTx?.stripePaymentIntentId) throw new Error('No escrow transaction found');

  await StripeService.captureHeldFunds(escrowTx.stripePaymentIntentId);

  const total = escrowTx.amount;
  const platformFee = Math.round(total * PLATFORM_FEE_RATE);

  const transfer = await StripeService.payoutVendor(
    ticket.vendor.stripeAccountId,
    total,
    platformFee,
    { ticketId }
  );

  await prisma.transaction.update({
    where: { id: escrowTx.id },
    data: { status: TransactionStatus.SUCCEEDED, stripeTransferId: transfer.id },
  });

  await prisma.transaction.create({
    data: {
      userId: ticket.vendorId!,
      ticketId,
      type: TransactionType.PLATFORM_FEE,
      status: TransactionStatus.SUCCEEDED,
      amount: -platformFee,
    },
  });

  await prisma.serviceTicket.update({
    where: { id: ticketId },
    data: { status: 'PAID' },
  });

  await Notify.notifyVendorPaid(
    ticket.vendor.email,
    ticket.vendor.phone ?? null,
    ticket.vendor.name,
    (total - platformFee) / 100
  );

  return { ticketId, vendorPayoutCents: total - platformFee, platformFeeCents: platformFee, transferId: transfer.id };
}
