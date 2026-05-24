/**
 * PropVoice API Routes
 * Endpoints for the dashboard, risk scoring, and payment plans.
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { scoreTenantRisk, detectAnomalies, recommendPaymentPlan } from '../services/RiskService.js';
import { createConnectedAccount, createTenantCustomer, createPaymentPlan } from '../services/StripeService.js';
import { finalizeAndPayJob } from '../services/MaintenanceManager.js';

const router = Router();
const prisma = new PrismaClient();

// ── Dashboard summary ─────────────────────────────────────────────────────────
router.get('/dashboard/:landlordId', async (req: Request, res: Response) => {
  try {
    const { landlordId } = req.params;

    const [properties, transactions, tickets, anomalies] = await Promise.all([
      prisma.property.findMany({
        where: { landlordId },
        include: { apartments: { include: { tenant: true } } },
      }),
      prisma.transaction.findMany({
        where: { userId: landlordId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      prisma.serviceTicket.findMany({
        where: { apartment: { property: { landlordId } } },
        include: { vendor: true, apartment: { include: { property: true } } },
        orderBy: { updatedAt: 'desc' },
      }),
      detectAnomalies(landlordId),
    ]);

    const escrowHeld = transactions
      .filter(t => t.status === 'IN_ESCROW')
      .reduce((s, t) => s + t.amount, 0);

    const revenueThisMonth = transactions
      .filter(t => t.type === 'RENT_COLLECTION' && t.status === 'SUCCEEDED' &&
        new Date(t.createdAt).getMonth() === new Date().getMonth())
      .reduce((s, t) => s + t.amount, 0);

    res.json({
      properties,
      transactions,
      tickets,
      anomalies,
      summary: {
        escrowHeldCents: escrowHeld,
        revenueThisMonthCents: revenueThisMonth,
        activeIssues: tickets.filter(t => !['PAID', 'RESOLVED'].includes(t.status)).length,
        propertiesCount: properties.length,
      },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Tenant risk score ─────────────────────────────────────────────────────────
router.get('/risk/:tenantId', async (req: Request, res: Response) => {
  try {
    const profile = await scoreTenantRisk(req.params.tenantId);
    const tenant = await prisma.user.findUnique({ where: { id: req.params.tenantId } });
    const apt = await prisma.apartment.findFirst({ where: { tenantId: req.params.tenantId } });

    const planRecommendation = apt
      ? recommendPaymentPlan(apt.rentAmount, profile.score)
      : null;

    res.json({ ...profile, planRecommendation });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Offer a payment plan to tenant ───────────────────────────────────────────
router.post('/payment-plan', async (req: Request, res: Response) => {
  try {
    const { tenantId, installments } = req.body;
    const tenant = await prisma.user.findUnique({ where: { id: tenantId } });
    if (!tenant?.stripeCustomerId) return res.status(400).json({ error: 'Tenant has no Stripe customer' });

    const apt = await prisma.apartment.findFirst({ where: { tenantId } });
    if (!apt) return res.status(404).json({ error: 'Apartment not found' });

    const intents = await createPaymentPlan(
      tenant.stripeCustomerId,
      apt.rentAmount,
      installments ?? 2,
      { tenantId, apartmentId: apt.id }
    );

    res.json({ installments: intents.map(pi => ({ id: pi.id, amount: pi.amount, status: pi.status })) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Onboard landlord/vendor to Stripe Connect ─────────────────────────────────
router.post('/onboard', async (req: Request, res: Response) => {
  try {
    const { userId } = req.body;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role !== 'LANDLORD' && user.role !== 'VENDOR') {
      return res.status(400).json({ error: 'Only landlords and vendors can onboard' });
    }

    const { accountId, onboardingUrl } = await createConnectedAccount(
      user.email, user.id, user.role as 'LANDLORD' | 'VENDOR'
    );

    await prisma.user.update({
      where: { id: userId },
      data: { stripeAccountId: accountId },
    });

    res.json({ onboardingUrl, accountId });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Register tenant payment method ────────────────────────────────────────────
router.post('/tenant/setup', async (req: Request, res: Response) => {
  try {
    const { userId, paymentMethodId } = req.body;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const customerId = await createTenantCustomer(
      user.email, user.name, user.phone ?? null, paymentMethodId, user.id
    );

    await prisma.user.update({ where: { id: userId }, data: { stripeCustomerId: customerId } });
    res.json({ customerId });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Finalize vendor job and release payment ───────────────────────────────────
router.post('/tickets/:ticketId/complete', async (req: Request, res: Response) => {
  try {
    const result = await finalizeAndPayJob(req.params.ticketId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Landlord anomalies ────────────────────────────────────────────────────────
router.get('/anomalies/:landlordId', async (req: Request, res: Response) => {
  try {
    const anomalies = await detectAnomalies(req.params.landlordId);
    res.json({ anomalies });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
