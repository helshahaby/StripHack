/**
 * PropVoice RentScheduler
 * "Set-and-forget" automated rent lifecycle:
 *   Day 25: Reminder to tenant
 *   Day 1:  Auto-collect rent
 *   Day 3:  Retry if failed
 *   Day 7:  Mark overdue, escalate
 *   Day 1:  Disburse to landlord after successful collection
 *
 * Uses node-cron. Mounted once at server startup.
 */

import cron from 'node-cron';
import { PrismaClient, RentStatus, TransactionType, TransactionStatus } from '@prisma/client';
import * as StripeService from './StripeService.js';
import * as NotificationService from './NotificationService.js';
import { scoreTenantRisk, detectAnomalies } from './RiskService.js';

const prisma = new PrismaClient();

const PLATFORM_DISBURSEMENT_RATE = 0.95; // Landlord gets 95% (5% platform fee)

// ─── Helper: cents to euros display ──────────────────────────────────────────
function eur(cents: number): number {
  return cents / 100;
}

// ─── Job 1: Send rent-due reminder (runs daily at 9am, triggers 5 days before 1st) ──

export function startReminderJob() {
  // Every day at 09:00
  cron.schedule('0 9 * * *', async () => {
    console.log('[RentScheduler] Running rent reminder check...');

    const today = new Date();
    const daysUntilFirst = 1 - today.getDate(); // Days until next 1st

    // Send reminder when 5 days out
    if (daysUntilFirst !== -5 && today.getDate() !== 25) return;

    const apartments = await prisma.apartment.findMany({
      where: { tenantId: { not: null }, rentStatus: { not: RentStatus.PAID } },
      include: { tenant: true, property: true },
    });

    for (const apt of apartments) {
      if (!apt.tenant) continue;
      await NotificationService.notifyRentDueSoon(
        apt.tenant.email,
        apt.tenant.phone ?? null,
        apt.tenant.name,
        eur(apt.rentAmount),
        5
      );
    }

    console.log(`[RentScheduler] Sent reminders to ${apartments.length} tenants`);
  });
}

// ─── Job 2: Auto-collect rent on the 1st of every month ──────────────────────

export function startRentCollectionJob() {
  // 1st of every month at 08:00
  cron.schedule('0 8 1 * *', async () => {
    console.log('[RentScheduler] Running monthly rent collection...');

    const apartments = await prisma.apartment.findMany({
      where: {
        tenantId: { not: null },
        tenant: { stripeCustomerId: { not: null } },
      },
      include: { tenant: true, property: { include: { landlord: true } } },
    });

    let collected = 0;
    let failed = 0;

    for (const apt of apartments) {
      if (!apt.tenant?.stripeCustomerId) continue;

      try {
        const pi = await StripeService.collectRent(
          apt.tenant.stripeCustomerId,
          apt.rentAmount,
          { apartmentId: apt.id, tenantId: apt.tenantId! }
        );

        await prisma.transaction.create({
          data: {
            userId: apt.tenantId!,
            type: TransactionType.RENT_COLLECTION,
            status: TransactionStatus.PENDING,
            amount: apt.rentAmount,
            stripePaymentIntentId: pi.id,
            stripeReference: pi.id.slice(0, 16),
          },
        });

        await prisma.apartment.update({
          where: { id: apt.id },
          data: { rentStatus: RentStatus.PENDING },
        });

        collected++;
      } catch (err) {
        console.error(`[RentScheduler] Failed to collect rent for apt ${apt.id}:`, err);

        await NotificationService.notifyRentFailed(
          apt.tenant.email,
          apt.tenant.phone ?? null,
          apt.tenant.name,
          eur(apt.rentAmount),
          'in 3 days'
        );

        failed++;
      }
    }

    console.log(`[RentScheduler] Collection complete — ${collected} succeeded, ${failed} failed`);
  });
}

// ─── Job 3: Retry failed payments on the 4th ────────────────────────────────

export function startRetryJob() {
  // 4th of every month at 09:00
  cron.schedule('0 9 4 * *', async () => {
    console.log('[RentScheduler] Running payment retry job...');

    const failedTransactions = await prisma.transaction.findMany({
      where: {
        type: TransactionType.RENT_COLLECTION,
        status: TransactionStatus.FAILED,
        createdAt: {
          gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
        },
      },
      include: {
        user: true,
        ticket: { include: { apartment: true } },
      },
    });

    for (const tx of failedTransactions) {
      if (!tx.user.stripeCustomerId) continue;

      try {
        const pi = await StripeService.retryFailedPayment(
          tx.user.stripeCustomerId,
          tx.amount,
          { originalTxId: tx.id, isRetry: 'true' }
        );

        await prisma.transaction.create({
          data: {
            userId: tx.userId,
            type: TransactionType.RENT_COLLECTION,
            status: TransactionStatus.PENDING,
            amount: tx.amount,
            stripePaymentIntentId: pi.id,
            stripeReference: `retry_${pi.id.slice(0, 12)}`,
          },
        });

        console.log(`[RentScheduler] Retry initiated for user ${tx.userId}`);
      } catch (err) {
        console.error(`[RentScheduler] Retry failed for tx ${tx.id}:`, err);

        // Score the tenant and check if payment plan is needed
        const risk = await scoreTenantRisk(tx.userId);
        if (risk.recommendation === 'OFFER_PAYMENT_PLAN' || risk.recommendation === 'ESCALATE') {
          await NotificationService.notifyRentOverdue(
            tx.user.email,
            tx.user.phone ?? null,
            tx.user.name,
            eur(tx.amount),
            3
          );
        }
      }
    }
  });
}

// ─── Job 4: Mark overdue on the 8th ──────────────────────────────────────────

export function startOverdueJob() {
  // 8th of every month at 09:00
  cron.schedule('0 9 8 * *', async () => {
    console.log('[RentScheduler] Running overdue marking job...');

    // Find apartments where rent is still pending this month
    const pendingApts = await prisma.apartment.findMany({
      where: { rentStatus: RentStatus.PENDING, tenantId: { not: null } },
      include: { tenant: true, property: { include: { landlord: true } } },
    });

    for (const apt of pendingApts) {
      if (!apt.tenant) continue;

      await prisma.apartment.update({
        where: { id: apt.id },
        data: { rentStatus: RentStatus.OVERDUE },
      });

      // Notify both tenant and landlord
      await NotificationService.notifyRentOverdue(
        apt.tenant.email,
        apt.tenant.phone ?? null,
        apt.tenant.name,
        eur(apt.rentAmount),
        7
      );

      await NotificationService.notifyLandlordPaymentAnomaly(
        apt.property.landlord.email,
        apt.property.landlord.name,
        `Rent from ${apt.tenant.name} at ${apt.property.address} ${apt.unitNumber} is now 7 days overdue`
      );
    }

    console.log(`[RentScheduler] Marked ${pendingApts.length} apartments as OVERDUE`);
  });
}

// ─── Job 5: Daily anomaly detection for landlords ────────────────────────────

export function startAnomalyDetectionJob() {
  // Every day at 07:00
  cron.schedule('0 7 * * *', async () => {
    console.log('[RentScheduler] Running anomaly detection...');

    const landlords = await prisma.user.findMany({
      where: { role: 'LANDLORD' },
    });

    for (const landlord of landlords) {
      const anomalies = await detectAnomalies(landlord.id);

      for (const anomaly of anomalies) {
        if (anomaly.severity === 'HIGH' || anomaly.severity === 'MEDIUM') {
          await NotificationService.notifyLandlordPaymentAnomaly(
            landlord.email,
            landlord.name,
            anomaly.description
          );
        }
      }

      if (anomalies.length > 0) {
        console.log(`[RentScheduler] Found ${anomalies.length} anomalies for landlord ${landlord.id}`);
      }
    }
  });
}

// ─── Start all jobs ───────────────────────────────────────────────────────────

export function startAllSchedulers() {
  startReminderJob();
  startRentCollectionJob();
  startRetryJob();
  startOverdueJob();
  startAnomalyDetectionJob();
  console.log('[RentScheduler] ✅ All cron jobs registered');
  console.log('  → Day 25: Rent reminders');
  console.log('  → Day  1: Auto rent collection');
  console.log('  → Day  4: Failed payment retries');
  console.log('  → Day  8: Overdue marking + landlord alerts');
  console.log('  → Daily : Anomaly detection\n');
}
