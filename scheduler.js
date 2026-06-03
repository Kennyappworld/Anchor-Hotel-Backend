import cron from 'node-cron';
import nodemailer from 'nodemailer';
import prisma from './prisma.js';

// ── Email Transporter ─────────────────────────────────────────────────────────
const getTransporter = () => nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT) || 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// ── Generate Report Data ──────────────────────────────────────────────────────
async function generateReportData(startDate, endDate, hotelId = null) {
  const dateFilter = { createdAt: { gte: startDate, lte: endDate } };
  const hotelFilter = hotelId ? { hotelId } : {};

  const [hotels, rooms, roomLogs, expenses, posTransactions, maintenance] = await Promise.all([
    prisma.hotel.findMany({
      where: hotelId ? { id: hotelId } : {},
      include: { rooms: true }
    }),
    prisma.room.findMany({ where: hotelFilter }),
    prisma.roomLog.findMany({ where: { ...hotelFilter, ...dateFilter } }),
    prisma.expense.findMany({ where: { ...hotelFilter, ...dateFilter } }),
    prisma.pOSSale.findMany({ where: { ...hotelFilter, ...dateFilter } }),        // ✅ FIXED: was pOSTransaction
    prisma.maintenanceLog.findMany({ where: { ...hotelFilter, ...dateFilter } }), // ✅ FIXED: was maintenanceRequest
  ]);

  const totalRooms = rooms.length;
  const occupiedRooms = rooms.filter(r => r.status === 'OCCUPIED').length;
  const totalRevenue = roomLogs.reduce((s, l) => s + (l.totalAmount || 0), 0);
  const totalExpenses = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const posRevenue = posTransactions.reduce((s, t) => s + Number(t.totalAmount || 0), 0);
  const netRevenue = totalRevenue + posRevenue - totalExpenses;

  return {
    hotels,
    period: { start: startDate, end: endDate },
    summary: {
      totalRooms,
      occupiedRooms,
      availableRooms: totalRooms - occupiedRooms,
      occupancyRate: totalRooms > 0 ? Math.round((occupiedRooms / totalRooms) * 100) : 0,
      totalBookings: roomLogs.length,
      totalRevenue,
      posRevenue,
      totalExpenses,
      netRevenue,
      maintenanceRequests: maintenance.length,
      resolvedMaintenance: maintenance.filter(m => m.status === 'RESOLVED').length,
    },
    hotelBreakdown: hotels.map(hotel => {
      const hotelRooms = rooms.filter(r => r.hotelId === hotel.id);
      const hotelLogs = roomLogs.filter(l => l.hotelId === hotel.id);
      const hotelExpenses = expenses.filter(e => e.hotelId === hotel.id);
      const hotelPOS = posTransactions.filter(t => t.hotelId === hotel.id);
      const hotelMaint = maintenance.filter(m => m.hotelId === hotel.id);
      return {
        name: hotel.name,
        totalRooms: hotelRooms.length,
        occupied: hotelRooms.filter(r => r.status === 'OCCUPIED').length,
        occupancyRate: hotelRooms.length > 0
          ? Math.round((hotelRooms.filter(r => r.status === 'OCCUPIED').length / hotelRooms.length) * 100) : 0,
        revenue: hotelLogs.reduce((s, l) => s + (l.totalAmount || 0), 0),
        posRevenue: hotelPOS.reduce((s, t) => s + (t.total || 0), 0),
        expenses: hotelExpenses.reduce((s, e) => s + (e.amount || 0), 0),
        maintenance: hotelMaint.length,
      };
    }),
  };
}

// ── Format Currency ───────────────────────────────────────────────────────────
const fmt = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;

// ── Build HTML Email ──────────────────────────────────────────────────────────
function buildEmailHTML(title, data, period) {
  const { summary, hotelBreakdown } = data;
  const hotelRows = hotelBreakdown.map(h => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${h.name}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;">${h.occupied}/${h.totalRooms} (${h.occupancyRate}%)</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${fmt(h.revenue)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${fmt(h.posRevenue)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${fmt(h.expenses)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;">${h.maintenance}</td>
    </tr>
  `).join('');

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;max-width:800px;margin:0 auto;padding:20px;color:#333;">
  <div style="background:#1B2A4A;padding:24px;border-radius:8px;margin-bottom:24px;">
    <h1 style="color:#fff;margin:0;font-size:24px;">🏨 Anchor Hotel Suite</h1>
    <p style="color:#C9A84C;margin:8px 0 0;">${title}</p>
    <p style="color:#aaa;margin:4px 0 0;font-size:13px;">
      Period: ${period.start.toLocaleDateString('en-GB')} — ${period.end.toLocaleDateString('en-GB')}
    </p>
  </div>

  <h2 style="color:#1B2A4A;border-bottom:2px solid #C9A84C;padding-bottom:8px;">Executive Summary</h2>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:24px;">
    ${[
      ['Total Rooms', `${summary.occupiedRooms}/${summary.totalRooms} occupied`],
      ['Occupancy Rate', `${summary.occupancyRate}%`],
      ['Total Bookings', summary.totalBookings],
      ['Room Revenue', fmt(summary.totalRevenue)],
      ['POS Revenue', fmt(summary.posRevenue)],
      ['Total Expenses', fmt(summary.totalExpenses)],
      ['Net Revenue', fmt(summary.netRevenue)],
      ['Maintenance Requests', summary.maintenanceRequests],
      ['Resolved Issues', summary.resolvedMaintenance],
    ].map(([label, value]) => `
      <div style="background:#f8f9fa;padding:16px;border-radius:8px;border-left:4px solid #C9A84C;">
        <p style="margin:0;font-size:12px;color:#666;text-transform:uppercase;">${label}</p>
        <p style="margin:4px 0 0;font-size:18px;font-weight:bold;color:#1B2A4A;">${value}</p>
      </div>
    `).join('')}
  </div>

  <h2 style="color:#1B2A4A;border-bottom:2px solid #C9A84C;padding-bottom:8px;">Hotel Performance Breakdown</h2>
  <table style="width:100%;border-collapse:collapse;font-size:14px;">
    <thead>
      <tr style="background:#1B2A4A;color:#fff;">
        <th style="padding:10px 12px;text-align:left;">Hotel</th>
        <th style="padding:10px 12px;text-align:center;">Occupancy</th>
        <th style="padding:10px 12px;text-align:right;">Room Revenue</th>
        <th style="padding:10px 12px;text-align:right;">POS Revenue</th>
        <th style="padding:10px 12px;text-align:right;">Expenses</th>
        <th style="padding:10px 12px;text-align:center;">Maintenance</th>
      </tr>
    </thead>
    <tbody>${hotelRows}</tbody>
    <tfoot>
      <tr style="background:#f0f4f8;font-weight:bold;">
        <td style="padding:10px 12px;">TOTAL</td>
        <td style="padding:10px 12px;text-align:center;">${summary.occupiedRooms}/${summary.totalRooms}</td>
        <td style="padding:10px 12px;text-align:right;">${fmt(summary.totalRevenue)}</td>
        <td style="padding:10px 12px;text-align:right;">${fmt(summary.posRevenue)}</td>
        <td style="padding:10px 12px;text-align:right;">${fmt(summary.totalExpenses)}</td>
        <td style="padding:10px 12px;text-align:center;">${summary.maintenanceRequests}</td>
      </tr>
    </tfoot>
  </table>

  <div style="margin-top:32px;padding:16px;background:#f8f9fa;border-radius:8px;font-size:12px;color:#666;">
    <p style="margin:0;">This is an automated report from Anchor Hotel Suite.</p>
    <p style="margin:4px 0 0;">Generated: ${new Date().toLocaleString('en-GB')}</p>
  </div>
</body>
</html>`;
}

// ── Send Report Email ─────────────────────────────────────────────────────────
async function sendReport(subject, htmlContent, recipients) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log('⚠️  SMTP not configured — skipping report email');
    return;
  }

  try {
    const transporter = getTransporter();
    for (const email of recipients) {
      await transporter.sendMail({
        from: `"${process.env.SMTP_FROM_NAME || 'Anchor Hotel Suite'}" <${process.env.SMTP_USER}>`,
        to: email,
        subject,
        html: htmlContent,
      });
      console.log(`✅ Report sent to ${email}`);
    }
  } catch (err) {
    console.error('❌ Report email failed:', err.message);
  }
}

// ── Get Report Recipients ─────────────────────────────────────────────────────
async function getRecipients() {
  const users = await prisma.user.findMany({
    where: {
      role: { in: ['SUPER_ADMIN', 'GROUP_ADMIN', 'HOTEL_MANAGER'] },
      isVerified: true,
      email: { not: null },
    },
    select: { email: true },
  });
  return users.map(u => u.email);
}

// ── Weekly Report — Every Monday at 7:00 AM ───────────────────────────────────
export function scheduleWeeklyReport() {
  cron.schedule('0 7 * * 1', async () => {
    console.log('📊 Generating weekly report...');
    try {
      const endDate = new Date();
      endDate.setHours(23, 59, 59, 999);
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 7);
      startDate.setHours(0, 0, 0, 0);

      const data = await generateReportData(startDate, endDate);
      const html = buildEmailHTML('Weekly Performance Report', data, { start: startDate, end: endDate });
      const recipients = await getRecipients();

      const weekStr = `${startDate.toLocaleDateString('en-GB')} - ${endDate.toLocaleDateString('en-GB')}`;
      await sendReport(`📊 Weekly Report | ${weekStr}`, html, recipients);
    } catch (err) {
      console.error('Weekly report error:', err.message);
    }
  }, { timezone: 'Africa/Lagos' });

  console.log('✅ Weekly report scheduled — Every Monday 7:00 AM (Lagos)');
}

// ── Monthly Report — 1st of Every Month at 7:00 AM ───────────────────────────
export function scheduleMonthlyReport() {
  cron.schedule('0 7 1 * *', async () => {
    console.log('📊 Generating monthly report...');
    try {
      const now = new Date();
      const startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const endDate = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

      const data = await generateReportData(startDate, endDate);
      const monthName = startDate.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
      const html = buildEmailHTML(`Monthly Performance Report — ${monthName}`, data, { start: startDate, end: endDate });
      const recipients = await getRecipients();

      await sendReport(`📊 Monthly Report | ${monthName}`, html, recipients);
    } catch (err) {
      console.error('Monthly report error:', err.message);
    }
  }, { timezone: 'Africa/Lagos' });

  console.log('✅ Monthly report scheduled — 1st of every month 7:00 AM (Lagos)');
}

// ── Manual Trigger (for testing via API) ─────────────────────────────────────
export async function triggerReport(type = 'weekly') {
  const now = new Date();
  let startDate, endDate, title;

  if (type === 'monthly') {
    startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    endDate = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    title = `Monthly Report — ${startDate.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}`;
  } else {
    endDate = new Date();
    endDate.setHours(23, 59, 59, 999);
    startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);
    startDate.setHours(0, 0, 0, 0);
    title = `Weekly Report — ${startDate.toLocaleDateString('en-GB')} to ${endDate.toLocaleDateString('en-GB')}`;
  }

  const data = await generateReportData(startDate, endDate);
  const html = buildEmailHTML(title, data, { start: startDate, end: endDate });
  const recipients = await getRecipients();
  await sendReport(`📊 ${title}`, html, recipients);
  return { sent: true, recipients, title };
}

// ── Subscription expiry check — runs daily at 8:00 AM Lagos ──────────────────
async function sendSubEmail({ to, subject, html }) {
  if (!process.env.SMTP_HOST) return;
  try {
    const port = parseInt(process.env.SMTP_PORT || '465');
    const secure = process.env.SMTP_SECURE === 'true' || port === 465;
    const nodemailer2 = await import('nodemailer');
    const t = nodemailer2.default.createTransport({
      host: process.env.SMTP_HOST, port, secure,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await t.sendMail({ from: `"Anchor Suites Limited" <${process.env.SMTP_USER}>`, to, subject, html });
  } catch(e) { console.error('[SubEmail]', e.message); }
}

export function scheduleSubscriptionChecks() {
  cron.schedule('0 8 * * *', async () => {
    try {
      const now = new Date();
      const warningDays = [14, 7, 3, 1];

      // 1. Mark expired subscriptions
      const expired = await prisma.subscription.updateMany({
        where: { status: 'ACTIVE', endDate: { lte: now } },
        data: { status: 'EXPIRED' },
      });

      if (expired.count > 0) {
        // Deactivate groups whose subscription just expired
        const expiredSubs = await prisma.subscription.findMany({
          where: { status: 'EXPIRED', endDate: { lte: now } },
          select: { groupId: true },
        });
        const groupIds = [...new Set(expiredSubs.map(s => s.groupId))];
        await prisma.hotelGroup.updateMany({
          where: { id: { in: groupIds } },
          data: { isActive: false },
        });
        console.log(`[Subscriptions] Expired ${expired.count} subscriptions, deactivated ${groupIds.length} groups`);
      }

      // 2. Send warning emails for upcoming expiries
      for (const days of warningDays) {
        const targetDate = new Date(now);
        targetDate.setDate(targetDate.getDate() + days);
        const dayStart = new Date(targetDate); dayStart.setHours(0,0,0,0);
        const dayEnd   = new Date(targetDate); dayEnd.setHours(23,59,59,999);

        const expiringSubs = await prisma.subscription.findMany({
          where: { status: 'ACTIVE', endDate: { gte: dayStart, lte: dayEnd } },
          include: {
            group: {
              include: {
                users: {
                  where: { role: 'GROUP_MANAGER', isVerified: true },
                  select: { email: true, name: true },
                },
              },
            },
          },
        });

        for (const sub of expiringSubs) {
          const gm = sub.group.users[0];
          if (!gm) continue;
          const urgency = days <= 3 ? '🚨 URGENT' : '⚠️ Reminder';
          await sendSubEmail({
            to: gm.email,
            subject: `${urgency}: ${sub.group.name} subscription expires in ${days} day${days > 1 ? 's' : ''}`,
            html: `
              <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
                <div style="background:${days <= 3 ? '#DC2626' : '#1A3A5C'};padding:20px 24px;">
                  <h2 style="color:#fff;margin:0;">🏨 Anchor Hotel Suite</h2>
                  <p style="color:#fecaca;margin:4px 0 0;">${urgency}: Subscription Expiry Notice</p>
                </div>
                <div style="padding:20px 24px;">
                  <p>Dear ${gm.name},</p>
                  <p>Your subscription for <strong>${sub.group.name}</strong> will expire in <strong>${days} day${days > 1 ? 's' : ''}</strong> on <strong>${new Date(sub.endDate).toLocaleDateString('en-NG', { dateStyle: 'full' })}</strong>.</p>
                  <p>Current plan: <strong>${sub.plan} — ₦${Number(sub.amountNgn).toLocaleString('en-NG')}</strong></p>
                  <p>Please contact your Anchor Suites account manager to renew your subscription and avoid service interruption.</p>
                  ${days <= 3 ? '<p style="color:#DC2626;font-weight:bold;">⚠️ Access to your hotels will be suspended upon expiry.</p>' : ''}
                  <hr style="border:1px solid #e2e8f0;margin:16px 0;">
                  <p style="color:#94A3B8;font-size:0.75rem;text-align:center;">Powered by <strong>Anchor Suites Limited</strong></p>
                </div>
              </div>`,
          });
        }
      }
    } catch (err) {
      console.error('[Subscription Scheduler]', err.message);
    }
  }, { timezone: 'Africa/Lagos' });

  console.log('✅ Subscription expiry checks scheduled — daily 8:00 AM (Lagos)');
}
