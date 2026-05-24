/**
 * PropVoice ElevenLabs Voice Agent Routes
 * POST /api/voice/webhook  — conversation lifecycle events
 * POST /api/voice/tools    — custom tool execution (getAvailableVendor, bookVendorAndHoldFunds)
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { autoDispatchTicket, authorizeJobCost } from '../services/MaintenanceManager.js';

const router = Router();
const prisma = new PrismaClient();

// ── ElevenLabs conversation lifecycle ─────────────────────────────────────────
router.post('/webhook', async (req: Request, res: Response) => {
  try {
    const { type, conversation_id, agent_id, user_id, transcript, summary, duration_seconds } = req.body;
    console.log(`[VoiceWebhook] ${type}`, { conversation_id });

    if (type === 'conversation_initiation') {
      await prisma.voiceSession.create({
        data: {
          elevenLabsCallId: conversation_id,
          userId: user_id ?? null,
          metadata: { agent_id, started_at: new Date().toISOString() },
        },
      }).catch(() => {}); // Ignore duplicate key errors
    } else if (type === 'conversation_summary' || type === 'post_call_transcription') {
      await prisma.voiceSession.upsert({
        where: { elevenLabsCallId: conversation_id ?? '' },
        update: { transcript: transcript ?? null, summary: summary ?? null, durationSeconds: duration_seconds ?? null },
        create: {
          elevenLabsCallId: conversation_id,
          userId: user_id ?? null,
          transcript: transcript ?? null,
          summary: summary ?? null,
          durationSeconds: duration_seconds ?? null,
        },
      });
    }

    res.status(200).json({ received: true });
  } catch (err) {
    const e = err as Error;
    console.error('[VoiceWebhook]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── ElevenLabs custom tool execution ─────────────────────────────────────────
router.post('/tools', async (req: Request, res: Response) => {
  const { tool_name, tool_call_id, parameters } = req.body;
  console.log(`[VoiceTool] ${tool_name}`, parameters);

  try {
    if (tool_name === 'getAvailableVendor') {
      const { serviceType } = parameters;
      const catMap: Record<string, string> = {
        plumbing: 'PLUMBING', cleaning: 'CLEANING',
        heating: 'HEATING', appliance: 'APPLIANCES',
        painting: 'PAINTING', electrical: 'ELECTRICAL',
      };

      const vendor = await prisma.user.findFirst({
        where: { role: 'VENDOR', isOnboardingDone: true },
      });

      if (!vendor) {
        return res.json({ tool_call_id, status: 'success',
          result: { available: false, message: `No vendor available for ${serviceType} right now.` } });
      }

      const nextSlot = new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString('en-AT', {
        weekday: 'long', month: 'long', day: 'numeric',
      });

      return res.json({
        tool_call_id, status: 'success',
        result: {
          available: true,
          vendorId: vendor.id,
          vendorName: vendor.name,
          estimatedPriceEur: 150, // Default estimate — refined after quote
          nextAvailableSlot: nextSlot,
          category: catMap[serviceType.toLowerCase()] ?? serviceType,
        },
      });
    }

    if (tool_name === 'bookVendorAndHoldFunds') {
      const { ticketId, vendorId, agreedPrice } = parameters;

      await prisma.serviceTicket.update({
        where: { id: ticketId },
        data: { vendorId },
      });

      const result = await authorizeJobCost(ticketId, Number(agreedPrice));

      return res.json({
        tool_call_id, status: 'success',
        result: {
          message: `Booking confirmed. I've placed a secure €${agreedPrice} hold via Stripe. The vendor is cleared to begin work.`,
          ticketId: result.ticketId,
          amountHeldCents: result.amountHeld,
        },
      });
    }

    return res.status(400).json({ tool_call_id, status: 'error', error: `Unknown tool: ${tool_name}` });
  } catch (err) {
    const e = err as Error;
    console.error('[VoiceTool] Error:', e.message);
    return res.status(500).json({ tool_call_id, status: 'error', error: e.message });
  }
});

export default router;
