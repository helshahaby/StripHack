/**
 * PropVoice RiskService
 * AI-driven risk scoring: late payer prediction, anomaly detection,
 * and dynamic payment plan recommendations.
 *
 * Uses heuristic rules now; plug in an ML model or OpenAI later
 * by replacing the scoring functions.
 */

import { PrismaClient, TransactionStatus, RentStatus } from '@prisma/client';

const prisma = new PrismaClient();

// ─── Risk Score (0–100, higher = riskier) ─────────────────────────────────────

export interface RiskProfile {
  tenantId: string;
  score: number;           // 0–100
  level: 'LOW' | 'MEDIUM' | 'HIGH';
  reasons: string[];
  recommendation: 'NONE' | 'SEND_REMINDER' | 'OFFER_PAYMENT_PLAN' | 'ESCALATE';
}

export async function scoreTenantRisk(tenantId: string): Promise<RiskProfile> {
  const reasons: string[] = [];
  let score = 0;

  // Fetch all transactions for this tenant
  const transactions = await prisma.transaction.findMany({
    where: { userId: tenantId },
    orderBy: { createdAt: 'desc' },
    take: 12, // Last 12 transactions
  });

  const rentTxns = transactions.filter(t => t.type === 'RENT_COLLECTION');
  const failed = rentTxns.filter(t => t.status === TransactionStatus.FAILED);
  const pending = rentTxns.filter(t => t.status === TransactionStatus.PENDING);

  // Rule 1: Failed payments in last 3 months
  const recentFailed = failed.filter(t => {
    const months = (Date.now() - t.createdAt.getTime()) / (1000 * 60 * 60 * 24 * 30);
    return months <= 3;
  });
  if (recentFailed.length >= 2) {
    score += 40;
    reasons.push(`${recentFailed.length} failed payments in last 3 months`);
  } else if (recentFailed.length === 1) {
    score += 20;
    reasons.push('1 failed payment recently');
  }

  // Rule 2: Currently overdue
  const apartment = await prisma.apartment.findFirst({
    where: { tenantId },
  });
  if (apartment?.rentStatus === RentStatus.OVERDUE) {
    score += 30;
    reasons.push('Rent currently overdue');
  }

  // Rule 3: Long pending duration (>5 days)
  const longPending = pending.filter(t => {
    const days = (Date.now() - t.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    return days > 5;
  });
  if (longPending.length > 0) {
    score += 15;
    reasons.push('Payment pending for more than 5 days');
  }

  // Rule 4: Historically high failure rate
  if (rentTxns.length > 0) {
    const failRate = failed.length / rentTxns.length;
    if (failRate > 0.3) {
      score += 20;
      reasons.push(`High failure rate: ${Math.round(failRate * 100)}% of payments`);
    }
  }

  // Clamp score 0–100
  score = Math.min(100, score);

  const level = score >= 60 ? 'HIGH' : score >= 30 ? 'MEDIUM' : 'LOW';

  const recommendation =
    score >= 70 ? 'ESCALATE' :
    score >= 50 ? 'OFFER_PAYMENT_PLAN' :
    score >= 25 ? 'SEND_REMINDER' :
    'NONE';

  return { tenantId, score, level, reasons, recommendation };
}

// ─── Anomaly Detection ────────────────────────────────────────────────────────

export interface Anomaly {
  type: string;
  description: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  affectedId: string;
}

export async function detectAnomalies(landlordId: string): Promise<Anomaly[]> {
  const anomalies: Anomaly[] = [];

  // Get all apartments owned by this landlord
  const properties = await prisma.property.findMany({
    where: { landlordId },
    include: {
      apartments: {
        include: {
          tenant: { include: { transactions: { orderBy: { createdAt: 'desc' }, take: 6 } } },
        },
      },
    },
  });

  for (const property of properties) {
    for (const apt of property.apartments) {
      if (!apt.tenant) continue;

      const txns = apt.tenant.transactions.filter(t => t.type === 'RENT_COLLECTION');

      // Anomaly: 2+ consecutive failures
      const last3 = txns.slice(0, 3);
      const consecutiveFails = last3.every(t => t.status === TransactionStatus.FAILED);
      if (consecutiveFails && last3.length >= 2) {
        anomalies.push({
          type: 'CONSECUTIVE_FAILURES',
          description: `${apt.tenant.name} at ${property.address} ${apt.unitNumber} has failed ${last3.length} payments in a row`,
          severity: 'HIGH',
          affectedId: apt.id,
        });
      }

      // Anomaly: Sudden overdue after reliable history
      const wasReliable = txns.slice(2, 8).every(t => t.status === TransactionStatus.SUCCEEDED);
      const isNowFailing = txns[0]?.status === TransactionStatus.FAILED;
      if (wasReliable && isNowFailing) {
        anomalies.push({
          type: 'SUDDEN_DEFAULT',
          description: `${apt.tenant.name} was consistently paying but just failed — may need outreach`,
          severity: 'MEDIUM',
          affectedId: apt.id,
        });
      }
    }
  }

  // Anomaly: Escrow held >14 days (vendor job stalled)
  const stalledTickets = await prisma.serviceTicket.findMany({
    where: {
      apartment: { property: { landlordId } },
      status: 'WORK_IN_PROGRESS',
      updatedAt: { lt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
    },
  });

  for (const ticket of stalledTickets) {
    anomalies.push({
      type: 'STALLED_ESCROW',
      description: `Ticket #${ticket.id.slice(0, 8)} (${ticket.category}) has had funds in escrow for >14 days with no resolution`,
      severity: 'MEDIUM',
      affectedId: ticket.id,
    });
  }

  return anomalies;
}

// ─── Payment Plan Recommendation ──────────────────────────────────────────────

export function recommendPaymentPlan(
  rentAmountCents: number,
  riskScore: number
): { installments: number; reason: string } | null {
  if (riskScore < 30) return null; // Low risk — no plan needed

  if (riskScore >= 70) {
    return { installments: 4, reason: 'High-risk tenant: weekly installments recommended' };
  }
  if (riskScore >= 50) {
    return { installments: 2, reason: 'Medium-risk tenant: bi-monthly split recommended' };
  }
  // 30–49: mild risk
  if (rentAmountCents > 150000) {
    return { installments: 2, reason: 'High rent amount: bi-monthly split available' };
  }

  return null;
}
