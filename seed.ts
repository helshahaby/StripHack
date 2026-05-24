/**
 * PropVoice — Database Seed
 * Run with: npm run db:seed
 *
 * Creates demo data for hackathon testing:
 * - 1 Landlord, 2 Tenants, 2 Vendors
 * - 2 Properties, 3 Apartments
 * - 3 Service Tickets (various statuses)
 * - 4 Transactions (rent + maintenance)
 */

import { PrismaClient, UserRole, ServiceCategory, TicketStatus, RentStatus, TransactionType, TransactionStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding PropVoice database...\n');

  // ─── Clean existing data (order matters due to FK constraints) ──────────────
  await prisma.transaction.deleteMany();
  await prisma.serviceTicket.deleteMany();
  await prisma.apartment.deleteMany();
  await prisma.property.deleteMany();
  await prisma.user.deleteMany();

  // ─── Users ──────────────────────────────────────────────────────────────────
  const landlord = await prisma.user.create({
    data: {
      email: 'samuel.cohen@propvoice.dev',
      name: 'Samuel Cohen',
      phone: '+4369912345678',
      role: UserRole.LANDLORD,
      stripeAccountId: 'acct_demo_landlord_001',
      isOnboardingDone: true,
    },
  });
  console.log(`✅ Landlord: ${landlord.name} (${landlord.id})`);

  const tenant1 = await prisma.user.create({
    data: {
      email: 'sarah.chen@tenant.dev',
      name: 'Sarah Chen',
      phone: '+4369987654321',
      role: UserRole.TENANT,
      stripeCustomerId: 'cus_demo_tenant_001',
    },
  });

  const tenant2 = await prisma.user.create({
    data: {
      email: 'marco.rivera@tenant.dev',
      name: 'Marco Rivera',
      phone: '+4369976543210',
      role: UserRole.TENANT,
      stripeCustomerId: 'cus_demo_tenant_002',
    },
  });
  console.log(`✅ Tenants: ${tenant1.name}, ${tenant2.name}`);

  const vendorPlumber = await prisma.user.create({
    data: {
      email: 'aquafix@vendor.dev',
      name: 'Hans Gruber',
      phone: '+4369965432109',
      role: UserRole.VENDOR,
      stripeAccountId: 'acct_demo_vendor_plumber',
      isOnboardingDone: true,
    },
  });

  const vendorCleaner = await prisma.user.create({
    data: {
      email: 'sparkle@vendor.dev',
      name: 'Maria Santos',
      phone: '+4369954321098',
      role: UserRole.VENDOR,
      stripeAccountId: 'acct_demo_vendor_cleaner',
      isOnboardingDone: true,
    },
  });
  console.log(`✅ Vendors: ${vendorPlumber.name} (Plumbing), ${vendorCleaner.name} (Cleaning)\n`);

  // ─── Properties ─────────────────────────────────────────────────────────────
  const property1 = await prisma.property.create({
    data: {
      name: 'Schottengasse Complex',
      address: 'Schottengasse 4, 1010 Wien',
      landlordId: landlord.id,
    },
  });

  const property2 = await prisma.property.create({
    data: {
      name: 'Praterstraße Residences',
      address: 'Praterstraße 22, 1020 Wien',
      landlordId: landlord.id,
    },
  });
  console.log(`✅ Properties: ${property1.name}, ${property2.name}`);

  // ─── Apartments ─────────────────────────────────────────────────────────────
  const apt1 = await prisma.apartment.create({
    data: {
      unitNumber: 'Apt 3B',
      propertyId: property1.id,
      tenantId: tenant1.id,
      rentAmount: 145000, // €1,450.00
      rentStatus: RentStatus.PAID,
    },
  });

  const apt2 = await prisma.apartment.create({
    data: {
      unitNumber: 'Apt 7A',
      propertyId: property1.id,
      tenantId: tenant2.id,
      rentAmount: 178000, // €1,780.00
      rentStatus: RentStatus.PENDING,
    },
  });

  const apt3 = await prisma.apartment.create({
    data: {
      unitNumber: 'Apt 1C',
      propertyId: property2.id,
      tenantId: null, // Vacant
      rentAmount: 120000, // €1,200.00
      rentStatus: RentStatus.OVERDUE,
    },
  });
  console.log(`✅ Apartments: ${apt1.unitNumber}, ${apt2.unitNumber}, ${apt3.unitNumber} (vacant)\n`);

  // ─── Service Tickets ────────────────────────────────────────────────────────
  const ticket1 = await prisma.serviceTicket.create({
    data: {
      apartmentId: apt1.id,
      category: ServiceCategory.PLUMBING,
      status: TicketStatus.WORK_IN_PROGRESS,
      vendorId: vendorPlumber.id,
      quotedAmount: 18000, // €180.00
      voiceSessionId: 'el_session_demo_001',
      latestTranscript:
        'Tenant reported: water is leaking under the kitchen sink, the cabinet floor is completely soaked. Vendor Hans confirmed availability for same day. €180 agreed and escrow hold placed via Stripe.',
    },
  });

  const ticket2 = await prisma.serviceTicket.create({
    data: {
      apartmentId: apt2.id,
      category: ServiceCategory.HEATING,
      status: TicketStatus.DISPATCHED,
      vendorId: vendorPlumber.id,
      quotedAmount: 22000, // €220.00
      voiceSessionId: 'el_session_demo_002',
      latestTranscript:
        'Tenant reported: radiator in bedroom is stone cold even though thermostat reads 22°C. Vendor dispatched. Awaiting confirmation of funds hold.',
    },
  });

  const ticket3 = await prisma.serviceTicket.create({
    data: {
      apartmentId: apt1.id,
      category: ServiceCategory.CLEANING,
      status: TicketStatus.PAID,
      vendorId: vendorCleaner.id,
      quotedAmount: 9500, // €95.00
      voiceSessionId: 'el_session_demo_003',
      latestTranscript:
        'Post-tenancy deep clean completed. Maria confirmed job done. Funds released from escrow to vendor. Platform fee (10%) retained.',
    },
  });
  console.log(`✅ Tickets: Plumbing (WIP), Heating (Dispatched), Cleaning (Paid)\n`);

  // ─── Transactions ────────────────────────────────────────────────────────────
  await prisma.transaction.createMany({
    data: [
      {
        userId: tenant1.id,
        type: TransactionType.RENT_COLLECTION,
        status: TransactionStatus.SUCCEEDED,
        amount: 145000,
        stripePaymentIntentId: 'pi_demo_rent_001',
        stripeReference: 'ch_demo_001',
      },
      {
        userId: landlord.id,
        ticketId: ticket1.id,
        type: TransactionType.VENDOR_ESCROW_HOLD,
        status: TransactionStatus.IN_ESCROW,
        amount: 18000,
        stripePaymentIntentId: 'pi_demo_escrow_001',
        stripeReference: 'ch_demo_002',
      },
      {
        userId: vendorCleaner.id,
        ticketId: ticket3.id,
        type: TransactionType.VENDOR_PAYOUT,
        status: TransactionStatus.SUCCEEDED,
        amount: 8550, // €95 - 10% platform fee
        stripeTransferId: 'tr_demo_payout_001',
        stripeReference: 'tr_demo_001',
      },
      {
        userId: landlord.id,
        ticketId: ticket3.id,
        type: TransactionType.PLATFORM_FEE,
        status: TransactionStatus.SUCCEEDED,
        amount: 950, // 10% of €95
        stripeReference: 'fee_demo_001',
      },
    ],
  });
  console.log(`✅ Transactions: Rent collected, Escrow hold, Vendor payout, Platform fee\n`);

  console.log('🎉 Seed complete! Database is ready for PropVoice hackathon demo.\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Demo login accounts:');
  console.log(`  Landlord : samuel.cohen@propvoice.dev`);
  console.log(`  Tenant 1 : sarah.chen@tenant.dev`);
  console.log(`  Tenant 2 : marco.rivera@tenant.dev`);
  console.log(`  Vendor 1 : aquafix@vendor.dev  (Plumbing/Heating)`);
  console.log(`  Vendor 2 : sparkle@vendor.dev  (Cleaning)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
