/**
 * PropVoice Stripe Webhook Handler
 * Mounted BEFORE express.json() — Stripe requires the raw body buffer.
 *
 * Handles:
 *   payment_intent.succeeded       → mark rent paid, disburse to landlord
 *   payment_intent.payment_failed  → mark failed, trigger retry flow
 *   account.updated                → complete landlord/vendor onboarding
 *   transfer.created               → log vendor payouts
 */

import { Router, Request, Response } from 'express';
import express from 'express';
import Stripe from 'stripe';
import { PrismaClient, RentStatus, TransactionStatus, TransactionType } from '@prisma/client';
import { stripe, disburseLandlord } from '../services/StripeService.js';
import * as Notify from '../services/NotificationService.js';

const router = Router();
const prisma = new PrismaClient();

const PLATFORM_FEE_RATE = 0.05; // 5% platform fee on rent
const LANDLORD_SHARE = 1 - PLATFORM_FEE_RATE;

router.post(
  '/stripe',
  express.raw({ type: 'application/json' }),
  async (req: Request, res: Response) => {
    const sig = req.headers['stripe-signature'] as string;
    const secret = process.env.STRIPE_WEBHOOK_SECRET!;

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } catch (err) {
      const e = err as Error;
      console.error('[Webhook] Signature verification failed:', e.message);
      return res.status(400).send(`Webhook Error: ${e.message}`);
    }

    console.log(`[Webhook] ← ${event.type}`);

    try {
      switch (event.type) {

        // ── Rent collected successfully ────────────────────────────────────────
        case 'payment_intent.succeeded': {
          const pi = event.data.object as Stripe.PaymentIntent;

          const tx = await prisma.transaction.findFirst({
            where: { stripePaymentIntentId: pi.id },
            include: { user: true },
          });
          if (!tx) break;

          // Update transaction
          await prisma.transaction.update({
            where: { id: tx.id },
            data: {
              status: TransactionStatus.SUCCEEDED,
              stripeReference: pi.latest_charge as string,
            },
          });

          // If this is rent collection, mark apartment paid
          if (tx.type === TransactionType.RENT_COLLECTION) {
            const apt = await prisma.apartment.findFirst({
              where: { tenantId: tx.userId },
              include: {
                property: {
                  include: { landlord: true },
                },
                tenant: true,
              },
            });

            if (apt) {
              await prisma.apartment.update({
                where: { id: apt.id },
                data: { rentStatus: RentStatus.PAID },
              });

              // Notify tenant
              await Notify.notifyRentCollected(
                tx.user.email,
                tx.user.name,
                tx.amount / 100
              );

              // Disburse to landlord (minus platform fee)
              const landlord = apt.property.landlord;
              if (landlord.stripeAccountId && landlord.isOnboardingDone) {
                const landlordAmount = Math.floor(tx.amount * LANDLORD_SHARE);
                const platformFee = tx.amount - landlordAmount;

                const transfer = await disburseLandlord(
                  landlord.stripeAccountId,
                  landlordAmount,
                  { tenantId: tx.userId, apartmentId: apt.id }
                );

                // Log disbursement transaction
                await prisma.transaction.create({
                  data: {
                    userId: landlord.id,
                    type: TransactionType.VENDOR_PAYOUT, // Reusing for landlord disbursement
                    status: TransactionStatus.SUCCEEDED,
                    amount: landlordAmount,
                    stripeTransferId: transfer.id,
                  },
                });

                // Log platform fee
                await prisma.transaction.create({
                  data: {
                    userId: landlord.id,
                    type: TransactionType.PLATFORM_FEE,
                    status: TransactionStatus.SUCCEEDED,
                    amount: -platformFee, // Negative = deducted
                  },
                });

                await Notify.notifyLandlordRentReceived(
                  landlord.email,
                  landlord.name,
                  tx.user.name,
                  landlordAmount / 100,
                  `${apt.property.address} ${apt.unitNumber}`
                );
              }
            }
          }

          // If this is maintenance escrow capture — ticket moves to RESOLVED
          if (tx.type === TransactionType.VENDOR_ESCROW_HOLD && tx.ticketId) {
            await prisma.serviceTicket.update({
              where: { id: tx.ticketId },
              data: { status: 'RESOLVED' },
            });
          }

          break;
        }

        // ── Payment failed — trigger retry flow ────────────────────────────────
        case 'payment_intent.payment_failed': {
          const pi = event.data.object as Stripe.PaymentIntent;

          const tx = await prisma.transaction.findFirst({
            where: { stripePaymentIntentId: pi.id },
            include: { user: true },
          });
          if (!tx) break;

          await prisma.transaction.update({
            where: { id: tx.id },
            data: { status: TransactionStatus.FAILED },
          });

          if (tx.type === TransactionType.RENT_COLLECTION) {
            const apt = await prisma.apartment.findFirst({
              where: { tenantId: tx.userId },
            });
            if (apt) {
              await prisma.apartment.update({
                where: { id: apt.id },
                data: { rentStatus: RentStatus.PENDING },
              });
            }

            await Notify.notifyRentFailed(
              tx.user.email,
              tx.user.phone ?? null,
              tx.user.name,
              tx.amount / 100,
              'in 3 days'
            );
          }

          console.error(`[Webhook] PaymentIntent failed: ${pi.id}`, pi.last_payment_error?.message);
          break;
        }

        // ── Landlord/Vendor completed Stripe onboarding ────────────────────────
        case 'account.updated': {
          const account = event.data.object as Stripe.Account;

          const user = await prisma.user.findFirst({
            where: { stripeAccountId: account.id },
          });
          if (!user) break;

          const fullyOnboarded = account.charges_enabled && account.payouts_enabled;

          await prisma.user.update({
            where: { id: user.id },
            data: { isOnboardingDone: fullyOnboarded },
          });

          console.log(
            `[Webhook] User ${user.id} (${user.role}) onboarding: ${fullyOnboarded ? 'COMPLETE ✅' : 'PENDING'}`
          );
          break;
        }

        default:
          console.log(`[Webhook] Unhandled: ${event.type}`);
      }

      res.json({ received: true });
    } catch (err) {
      const e = err as Error;
      console.error('[Webhook] Handler error:', e.message);
      res.status(500).json({ error: e.message });
    }
  }
);

export default router;
