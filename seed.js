import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting database seed...');

  // Create Super Admin
  const superAdminEmail = process.env.SUPER_ADMIN_EMAIL || 'kennyappworld@gmail.com';
  const superAdminPassword = process.env.SUPER_ADMIN_PASSWORD || 'AnchorAdmin@2024!';
  const passwordHash = await bcrypt.hash(superAdminPassword, 12);

  const superAdmin = await prisma.user.upsert({
    where: { email: superAdminEmail },
    update: {},
    create: {
      email: superAdminEmail,
      name: process.env.SUPER_ADMIN_NAME || 'Super Administrator',
      role: 'SUPER_ADMIN',
      accessLevel: 10,
      isVerified: true,
      passwordHash,
    },
  });

  console.log(`✅ Super Admin created: ${superAdmin.email}`);

  // Create a sample hotel
  const sampleHotel = await prisma.hotel.upsert({
    where: { id: 'sample-hotel-001' },
    update: {},
    create: {
      id: 'sample-hotel-001',
      name: 'Anchor Grand Hotel',
      address: '1 Victoria Island, Lagos, Nigeria',
      phone: '+234 800 000 0000',
      email: 'info@anchorgrand.com',
      totalRooms: 50,
      currency: 'NGN',
      timezone: 'Africa/Lagos',
    },
  });

  console.log(`✅ Sample hotel created: ${sampleHotel.name}`);

  // Create sample rooms
  const roomTypes = [
    { type: 'STANDARD', price: 25000, count: 20, floor: 1 },
    { type: 'DELUXE', price: 45000, count: 15, floor: 2 },
    { type: 'SUITE', price: 85000, count: 10, floor: 3 },
    { type: 'PENTHOUSE', price: 150000, count: 5, floor: 4 },
  ];

  let roomNumber = 101;
  for (const rt of roomTypes) {
    for (let i = 0; i < rt.count; i++) {
      await prisma.room.upsert({
        where: {
          hotelId_number: {
            hotelId: sampleHotel.id,
            number: roomNumber.toString(),
          },
        },
        update: {},
        create: {
          hotelId: sampleHotel.id,
          number: roomNumber.toString(),
          type: rt.type,
          floor: rt.floor,
          pricePerNight: rt.price,
          maxOccupants: rt.type === 'SUITE' || rt.type === 'PENTHOUSE' ? 4 : 2,
        },
      });
      roomNumber++;
      if (roomNumber % 100 === 100) roomNumber += 1; // Skip xx00 numbers
    }
    if (rt.floor === 1) roomNumber = 201;
    if (rt.floor === 2) roomNumber = 301;
    if (rt.floor === 3) roomNumber = 401;
  }

  console.log(`✅ Sample rooms created`);

  // Create POS inventory items
  const posItems = [
    // Bar items
    { name: 'Star Beer (33cl)', category: 'BAR', price: 800, stock: 200, unit: 'bottle' },
    { name: 'Heineken (33cl)', category: 'BAR', price: 1000, stock: 150, unit: 'bottle' },
    { name: 'Guinness (33cl)', category: 'BAR', price: 900, stock: 150, unit: 'bottle' },
    { name: 'Whisky (Shot)', category: 'BAR', price: 2500, stock: 100, unit: 'shot' },
    { name: 'Soft Drink (35cl)', category: 'BAR', price: 400, stock: 300, unit: 'bottle' },
    { name: 'Water (50cl)', category: 'BAR', price: 200, stock: 500, unit: 'bottle' },
    { name: 'Juice (500ml)', category: 'BAR', price: 600, stock: 200, unit: 'bottle' },
    // Restaurant items
    { name: 'Jollof Rice + Chicken', category: 'RESTAURANT', price: 3500, stock: 50, unit: 'plate' },
    { name: 'Fried Rice + Fish', category: 'RESTAURANT', price: 4000, stock: 50, unit: 'plate' },
    { name: 'Pounded Yam + Egusi', category: 'RESTAURANT', price: 4500, stock: 30, unit: 'plate' },
    { name: 'Suya (100g)', category: 'RESTAURANT', price: 2000, stock: 50, unit: 'portion' },
    { name: 'Club Sandwich', category: 'RESTAURANT', price: 3000, stock: 30, unit: 'plate' },
    { name: 'Breakfast Platter', category: 'RESTAURANT', price: 5000, stock: 20, unit: 'plate' },
    { name: 'Pepper Soup', category: 'RESTAURANT', price: 3500, stock: 30, unit: 'bowl' },
    // Laundry
    { name: 'Shirt Wash & Iron', category: 'LAUNDRY', price: 1500, stock: 999, unit: 'piece' },
    { name: 'Trouser Wash & Iron', category: 'LAUNDRY', price: 2000, stock: 999, unit: 'piece' },
    { name: 'Suit Dry Clean', category: 'LAUNDRY', price: 5000, stock: 999, unit: 'piece' },
  ];

  for (const item of posItems) {
    await prisma.pOSInventory.create({
      data: {
        hotelId: sampleHotel.id,
        name: item.name,
        category: item.category,
        price: item.price,
        stock: item.stock,
        unit: item.unit,
      },
    }).catch(() => {}); // Ignore duplicates
  }

  console.log(`✅ POS inventory created`);
  console.log('\n🎉 Seed complete!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📧 Super Admin Email: ${superAdminEmail}`);
  console.log(`🔑 Super Admin Password: ${superAdminPassword}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('⚠️  CHANGE YOUR PASSWORD AFTER FIRST LOGIN!');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
