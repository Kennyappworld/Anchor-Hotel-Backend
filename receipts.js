/**
 * receipts.js
 * On-demand PDF receipt generation for:
 *   • POS sales  →  GET /api/receipts/pos/:saleId
 *   • Room stays →  GET /api/receipts/room/:roomLogId
 *
 * Returns a streamed application/pdf response so the frontend can either:
 *   a) Open it in a new tab  (window.open(url))
 *   b) Trigger a download    (anchor with download attribute)
 *   c) Email it              (POST /api/receipts/pos/:saleId/email)
 *
 * The receipt header is populated from the Hotel record, including:
 *   • Hotel name, address, phone, email (the branch's own contact details)
 *   • Logo placeholder (text-based if no logo URL)
 *   • Receipt number, date, cashier name
 *
 * Dependencies (already in package.json after this update):
 *   pdfkit  ^0.15.x
 */

import express from 'express';
import PDFDocument from 'pdfkit';
import nodemailer from 'nodemailer';
import prisma from './prisma.js';
import { authenticate, requireLevel } from './middleware.js';

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/receipts/pos/:saleId
// Download a PDF receipt for a single POS sale
// ─────────────────────────────────────────────────────────────────────────────
router.get('/pos/:saleId', authenticate, requireLevel(3), async (req, res) => {
  try {
    const sale = await prisma.pOSSale.findUnique({
      where: { id: req.params.saleId },
      include: {
        items: true,
        hotel: true,
        staff: { select: { name: true } },
        roomLog: { select: { guestName: true, room: { select: { number: true } } } },
      },
    });

    if (!sale) return res.status(404).json({ error: 'Sale not found' });

    // Scope guard: non-super-admins can only access their own hotel's receipts
    if (req.user.role !== 'SUPER_ADMIN' && sale.hotelId !== req.user.hotelId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const filename = `POS-Receipt-${sale.id.slice(-8).toUpperCase()}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);

    const doc = buildPOSReceipt(sale);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    console.error('POS receipt error:', err);
    res.status(500).json({ error: 'Failed to generate receipt' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/receipts/room/:roomLogId
// Download a PDF receipt for a guest's full stay (checkout receipt)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/room/:roomLogId', authenticate, requireLevel(5), async (req, res) => {
  try {
    const log = await prisma.roomLog.findUnique({
      where: { id: req.params.roomLogId },
      include: {
        room: true,
        hotel: true,
        createdBy: { select: { name: true } },
        transactions: { orderBy: { createdAt: 'asc' } },
        creditLedger: { orderBy: { date: 'asc' } },
        posSales: {
          include: { items: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!log) return res.status(404).json({ error: 'Room log not found' });

    if (req.user.role !== 'SUPER_ADMIN' && log.hotelId !== req.user.hotelId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const filename = `Stay-Receipt-${log.guestName.replace(/\s+/g, '-')}-${log.id.slice(-8).toUpperCase()}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);

    const doc = buildRoomReceipt(log);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    console.error('Room receipt error:', err);
    res.status(500).json({ error: 'Failed to generate receipt' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/receipts/pos/:saleId/email
// Generate and email a POS receipt to a provided address
// Body: { email: "guest@example.com" }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/pos/:saleId/email', authenticate, requireLevel(3), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Recipient email required' });

    const sale = await prisma.pOSSale.findUnique({
      where: { id: req.params.saleId },
      include: {
        items: true,
        hotel: true,
        staff: { select: { name: true } },
        roomLog: { select: { guestName: true, room: { select: { number: true } } } },
      },
    });
    if (!sale) return res.status(404).json({ error: 'Sale not found' });

    const result = await emailReceipt({
      email,
      hotel: sale.hotel,
      subject: `Your receipt from ${sale.hotel.name}`,
      pdfBuffer: await streamToBuffer(buildPOSReceipt(sale)),
      filename: `POS-Receipt-${sale.id.slice(-8).toUpperCase()}.pdf`,
    });

    res.json({ sent: result.success, error: result.error || null });
  } catch (err) {
    console.error('Email POS receipt error:', err);
    res.status(500).json({ error: 'Failed to email receipt' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/receipts/room/:roomLogId/email
// Email a room-stay receipt.
//
// Window rules:
//   • ACTIVE or checked out ≤ 12 hrs → level 5+ (any front desk)
//   • Checked out > 12 hrs           → level 7+ (GM only)
//
// Body: { email: "override@example.com" }  — optional
// ─────────────────────────────────────────────────────────────────────────────
router.post('/room/:roomLogId/email', authenticate, requireLevel(5), async (req, res) => {
  try {
    const log = await prisma.roomLog.findUnique({
      where: { id: req.params.roomLogId },
      include: {
        room: true, hotel: true,
        createdBy:    { select: { name: true } },
        transactions: { orderBy: { createdAt: 'asc' } },
        creditLedger: { orderBy: { date:      'asc' } },
        posSales:     { include: { items: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!log) return res.status(404).json({ error: 'Room log not found' });

    if (req.user.role !== 'SUPER_ADMIN' && log.hotelId !== req.user.hotelId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // ── 12-hour window enforcement ────────────────────────────────────────
    const WINDOW_MS = 12 * 60 * 60 * 1000;
    const isGM      = req.user.accessLevel >= 7;

    if (log.status === 'CHECKED_OUT' && log.checkedOutAt) {
      const elapsed = Date.now() - new Date(log.checkedOutAt).getTime();
      if (elapsed > WINDOW_MS && !isGM) {
        return res.status(403).json({
          error: 'Receipt window expired (12 hrs after checkout). Only a General Manager can resend this.',
          hoursElapsed: Math.round(elapsed / 3600000),
          gmRequired:   true,
        });
      }
    }

    const recipientEmail = req.body.email || log.guestEmail;
    if (!recipientEmail) {
      return res.status(400).json({ error: 'No email on file. Provide one in the request body.' });
    }

    const result = await emailReceipt({
      email:     recipientEmail,
      hotel:     log.hotel,
      subject:   `Your stay receipt from ${log.hotel.name}`,
      pdfBuffer: await streamToBuffer(buildRoomReceipt(log)),
      filename:  `Stay-Receipt-${log.guestName.replace(/\s+/g, '-')}-${log.id.slice(-8).toUpperCase()}.pdf`,
    });

    // Stamp receiptSentAt if sent successfully
    if (result.success) {
      await prisma.roomLog.update({
        where: { id: log.id },
        data:  { receiptSentAt: new Date() },
      });
    }

    res.json({ sent: result.success, sentTo: recipientEmail, error: result.error || null });
  } catch (err) {
    console.error('Email room receipt error:', err);
    res.status(500).json({ error: 'Failed to email receipt' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// PDF BUILDERS
// ═════════════════════════════════════════════════════════════════════════════

const NAVY   = '#1A3A5C';
const TEAL   = '#0D9488';
const LGREY  = '#F1F5F9';
const MGREY  = '#94A3B8';
const DGREY  = '#334155';
const WHITE  = '#FFFFFF';
const RED    = '#DC2626';
const RECEIPT_WIDTH = 400; // ~thermal receipt width in points

/**
 * Build a POS receipt PDFDocument (piped to stream)
 */
function buildPOSReceipt(sale) {
  const doc = new PDFDocument({
    size: [RECEIPT_WIDTH, 700], // tall enough; content drives actual height
    margins: { top: 20, bottom: 20, left: 24, right: 24 },
    autoFirstPage: true,
    bufferPages: true,
  });

  const hotel  = sale.hotel;
  const W      = RECEIPT_WIDTH - 48; // usable width
  let   y      = 20;

  // ── Header ───────────────────────────────────────────────────────────────
  drawHotelHeader(doc, hotel, W, y);
  y += headerHeight(hotel);

  // Receipt label
  doc.rect(24, y, W, 20).fill(NAVY);
  doc.fontSize(9).fillColor(WHITE).font('Helvetica-Bold')
     .text('POS RECEIPT', 24, y + 6, { width: W, align: 'center' });
  y += 24;

  // Meta row
  doc.fillColor(DGREY).fontSize(8).font('Helvetica');
  const receiptNo = `RCP-${sale.id.slice(-8).toUpperCase()}`;
  const saleDate  = new Date(sale.createdAt).toLocaleString('en-NG', {
    dateStyle: 'medium', timeStyle: 'short',
  });
  doc.text(`Receipt No: ${receiptNo}`, 24, y);
  doc.text(`Date: ${saleDate}`, 24, y + 11);
  doc.text(`Cashier: ${sale.staff?.name || 'Staff'}`, 24, y + 22);
  if (sale.roomLog) {
    doc.text(`Guest: ${sale.roomLog.guestName}  (Room ${sale.roomLog.room?.number || '—'})`, 24, y + 33);
    y += 11;
  }
  y += 46;

  divider(doc, y, W); y += 8;

  // ── Items ────────────────────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(8).fillColor(NAVY);
  doc.text('ITEM', 24, y);
  doc.text('QTY', 200, y, { width: 40, align: 'right' });
  doc.text('UNIT', 250, y, { width: 60, align: 'right' });
  doc.text('TOTAL', 318, y, { width: 54, align: 'right' });
  y += 13;
  divider(doc, y, W); y += 6;

  doc.font('Helvetica').fontSize(8).fillColor(DGREY);
  sale.items.forEach((item) => {
    const rowH = 14;
    doc.text(item.name, 24, y, { width: 170 });
    doc.text(String(item.quantity), 200, y, { width: 40, align: 'right' });
    doc.text(fmt(item.unitPrice), 250, y, { width: 60, align: 'right' });
    doc.text(fmt(item.totalPrice), 318, y, { width: 54, align: 'right' });
    // Category badge
    doc.fillColor(TEAL).fontSize(6.5)
       .text(item.category, 24, y + 8, { width: 80 });
    doc.fillColor(DGREY).fontSize(8);
    y += rowH + 8;
  });

  y += 4;
  divider(doc, y, W); y += 8;

  // ── Totals with VAT ──────────────────────────────────────────────────────
  const vatRate    = Number(hotel.vatPercent ?? 7.5) / 100;
  const subTotal   = Number(sale.totalAmount);
  const vatAmount  = parseFloat((subTotal * vatRate).toFixed(2));
  const grandTotal = parseFloat((subTotal + vatAmount).toFixed(2));

  // Sub-total line
  doc.font('Helvetica').fontSize(8).fillColor(DGREY);
  doc.text('Sub-Total', 24, y);
  doc.text(fmt(subTotal), 24, y, { width: W, align: 'right' });
  y += 13;

  // VAT line
  const vatLabel = `VAT (${Number(hotel.vatPercent ?? 7.5)}%)`;
  doc.text(vatLabel, 24, y);
  doc.text(fmt(vatAmount), 24, y, { width: W, align: 'right' });
  y += 13;

  divider(doc, y, W); y += 6;

  // Grand total
  doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY);
  doc.text('TOTAL', 24, y);
  doc.text(fmt(grandTotal), 24, y, { width: W, align: 'right' });
  y += 14;

  doc.font('Helvetica').fontSize(8).fillColor(MGREY);
  doc.text(`Payment Method: ${sale.paymentType.replace(/_/g, ' ')}`, 24, y);
  doc.text(`Incl. VAT @ ${Number(hotel.vatPercent ?? 7.5)}%`, 24, y + 10, { width: W, align: 'right' });
  y += 24;

  divider(doc, y, W); y += 10;

  // ── Footer ───────────────────────────────────────────────────────────────
  drawReceiptFooter(doc, hotel, y, W);

  // Trim document to content
  doc.page.height = y + 80;
  return doc;
}

/**
 * Build a full room-stay receipt PDFDocument
 */
function buildRoomReceipt(log) {
  const doc = new PDFDocument({
    size: 'A5',
    margins: { top: 24, bottom: 24, left: 28, right: 28 },
    autoFirstPage: true,
    bufferPages: true,
  });

  const hotel = log.hotel;
  const room  = log.room;
  const W     = 420 - 56; // A5 width minus margins
  let   y     = 24;

  // ── Header ───────────────────────────────────────────────────────────────
  drawHotelHeader(doc, hotel, W, y);
  y += headerHeight(hotel);

  // Title banner
  const bannerLabel = log.status === 'CHECKED_OUT' ? 'CHECKOUT RECEIPT' : 'STAY RECEIPT';
  doc.rect(28, y, W, 22).fill(NAVY);
  doc.fontSize(10).fillColor(WHITE).font('Helvetica-Bold')
     .text(bannerLabel, 28, y + 7, { width: W, align: 'center' });
  y += 28;

  // ── Stay Details ─────────────────────────────────────────────────────────
  const receiptNo = `STAY-${log.id.slice(-8).toUpperCase()}`;
  twoCol(doc, 28, y, W, 'Receipt No:', receiptNo); y += 13;
  twoCol(doc, 28, y, W, 'Issue Date:', new Date().toLocaleDateString('en-NG', { dateStyle: 'medium' })); y += 13;
  twoCol(doc, 28, y, W, 'Prepared By:', log.createdBy?.name || 'Front Desk'); y += 18;

  doc.rect(28, y, W, 1).fill(MGREY); y += 8;

  // Guest info block
  doc.font('Helvetica-Bold').fontSize(8).fillColor(NAVY).text('GUEST INFORMATION', 28, y); y += 12;
  twoCol(doc, 28, y, W, 'Guest Name:', log.guestName); y += 12;
  if (log.guestEmail)  { twoCol(doc, 28, y, W, 'Email:', log.guestEmail); y += 12; }
  if (log.guestPhone)  { twoCol(doc, 28, y, W, 'Phone:', log.guestPhone); y += 12; }
  if (log.guestIdType) { twoCol(doc, 28, y, W, 'ID:', `${log.guestIdType}  ${log.guestIdNumber || ''}`); y += 12; }
  y += 6;

  doc.rect(28, y, W, 1).fill(MGREY); y += 8;

  // Room & dates
  doc.font('Helvetica-Bold').fontSize(8).fillColor(NAVY).text('ROOM & STAY DETAILS', 28, y); y += 12;
  twoCol(doc, 28, y, W, 'Room No:', room?.number || '—'); y += 12;
  twoCol(doc, 28, y, W, 'Room Type:', room?.type || '—'); y += 12;
  twoCol(doc, 28, y, W, 'Check-In:', fmtDate(log.checkInDate)); y += 12;
  twoCol(doc, 28, y, W, 'Check-Out:', log.checkedOutAt ? fmtDate(log.checkedOutAt) : fmtDate(log.checkOutDate)); y += 12;
  twoCol(doc, 28, y, W, 'Duration:', `${log.nights} night${log.nights !== 1 ? 's' : ''}`); y += 12;
  twoCol(doc, 28, y, W, 'Rate / Night:', fmt(log.ratePerNight)); y += 16;

  doc.rect(28, y, W, 1).fill(MGREY); y += 8;

  // ── Charges breakdown ─────────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(8).fillColor(NAVY).text('CHARGES', 28, y); y += 12;

  // Accommodation charge
  chargeRow(doc, 28, y, W, `Accommodation (${log.nights} nights × ${fmt(log.ratePerNight)})`, Number(log.ratePerNight) * log.nights);
  y += 14;

  // POS charges aggregated by category
  if (log.posSales && log.posSales.length > 0) {
    const posByCategory = {};
    log.posSales.forEach((s) => {
      s.items.forEach((item) => {
        if (!posByCategory[item.category]) posByCategory[item.category] = 0;
        posByCategory[item.category] += Number(item.totalPrice);
      });
    });
    Object.entries(posByCategory).forEach(([cat, total]) => {
      chargeRow(doc, 28, y, W, cat.charAt(0) + cat.slice(1).toLowerCase() + ' charges', total);
      y += 14;
    });
  }

  // Other transactions
  const extras = log.transactions.filter((t) => t.category === 'ROOM_EXTRAS');
  extras.forEach((t) => {
    chargeRow(doc, 28, y, W, t.description || 'Additional charges', Number(t.amount));
    y += 14;
  });

  y += 4;
  doc.rect(28, y, W, 1).fill(MGREY); y += 8;

  // ── Summary totals ────────────────────────────────────────────────────────
  const vatRate2     = Number(log.hotel.vatPercent ?? 7.5) / 100;
  const accommodationBase = Number(log.ratePerNight) * log.nights;
  const posTotal     = (log.posSales || []).reduce((sum, s) =>
    sum + s.items.reduce((a, i) => a + Number(i.totalPrice), 0), 0);
  const extrasTotal  = log.transactions
    .filter((t) => t.category === 'ROOM_EXTRAS')
    .reduce((sum, t) => sum + Number(t.amount), 0);
  const chargesBase  = accommodationBase + posTotal + extrasTotal;
  const vatAmount2   = parseFloat((chargesBase * vatRate2).toFixed(2));
  const grandTotal2  = parseFloat((chargesBase + vatAmount2).toFixed(2));
  const vatLabel2    = `VAT (${Number(log.hotel.vatPercent ?? 7.5)}%)`;

  twoCol(doc, 28, y, W, 'Charges Sub-Total:', fmt(chargesBase), false, 9); y += 14;
  twoCol(doc, 28, y, W, vatLabel2 + ':', fmt(vatAmount2), false, 9, DGREY); y += 14;
  twoCol(doc, 28, y, W, 'Amount Paid:', fmt(log.amountPaid), false, 9, TEAL); y += 14;

  const balance = Number(log.amountPaid) - grandTotal2;
  const balanceColor = balance < 0 ? RED : TEAL;
  const balanceLabel = balance < 0 ? 'Balance Due:' : 'Change / Credit:';
  twoCol(doc, 28, y, W, balanceLabel, fmt(Math.abs(balance)), false, 9, balanceColor); y += 18;

  // Big total box
  doc.rect(28, y, W, 26).fill(NAVY);
  doc.fontSize(11).font('Helvetica-Bold').fillColor(WHITE)
     .text('TOTAL (INCL. VAT)', 28, y + 8, { width: W / 2, align: 'left' });
  doc.text(fmt(grandTotal2), 28, y + 8, { width: W - 6, align: 'right' });
  y += 32;

  // Status badge
  const statusColor = log.status === 'CHECKED_OUT' ? TEAL : (log.status === 'CANCELLED' ? RED : NAVY);
  doc.rect(28, y, 80, 16).fill(statusColor);
  doc.fontSize(7.5).font('Helvetica-Bold').fillColor(WHITE)
     .text(log.status.replace('_', ' '), 28, y + 5, { width: 80, align: 'center' });
  y += 24;

  // ── POS itemisation (expandable section) ──────────────────────────────────
  if (log.posSales && log.posSales.length > 0) {
    doc.rect(28, y, W, 1).fill(MGREY); y += 8;
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(NAVY).text('POS / EXTRAS DETAIL', 28, y); y += 12;

    log.posSales.forEach((sale) => {
      const saleDate = new Date(sale.createdAt).toLocaleDateString('en-NG');
      doc.font('Helvetica-Bold').fontSize(7).fillColor(TEAL).text(`Sale on ${saleDate}`, 28, y); y += 10;
      sale.items.forEach((item) => {
        doc.font('Helvetica').fontSize(7.5).fillColor(DGREY);
        doc.text(`  ${item.name} × ${item.quantity}`, 28, y, { width: W * 0.65 });
        doc.text(fmt(item.totalPrice), 28, y, { width: W - 6, align: 'right' });
        y += 11;
      });
      y += 3;
    });
  }

  y += 8;
  divider(doc, y, W, 28); y += 10;

  // ── Footer ───────────────────────────────────────────────────────────────
  drawReceiptFooter(doc, hotel, y, W, 28);

  return doc;
}

// ═════════════════════════════════════════════════════════════════════════════
// SHARED DRAWING HELPERS
// ═════════════════════════════════════════════════════════════════════════════

function drawHotelHeader(doc, hotel, W, y, marginLeft = 24) {
  const pad = 10;
  const iW  = W - pad * 2;

  // ── Navy top bar: hotel name ──────────────────────────────────────────────
  doc.rect(marginLeft, y, W, 30).fill(NAVY);
  doc.fontSize(15).font('Helvetica-Bold').fillColor(WHITE)
     .text(hotel.name || 'Hotel', marginLeft + pad, y + 8, { width: iW });
  y += 34;

  // ── Light grey detail band ────────────────────────────────────────────────
  const detailLines = [];
  if (hotel.address) detailLines.push({ icon: 'Address:', text: hotel.address });
  if (hotel.phone)   detailLines.push({ icon: 'Phone:',   text: hotel.phone });
  if (hotel.email)   detailLines.push({ icon: 'Email:',   text: hotel.email });

  const bandH = Math.max(32, detailLines.length * 14 + 10);
  doc.rect(marginLeft, y, W, bandH).fill(LGREY);

  let dy = y + 7;
  detailLines.forEach(({ icon, text }) => {
    doc.fontSize(7.5).font('Helvetica-Bold').fillColor(NAVY)
       .text(icon, marginLeft + pad, dy, { width: 45, continued: false });
    const isEmail = icon === 'Email:';
    doc.fontSize(7.5).font('Helvetica')
       .fillColor(isEmail ? TEAL : DGREY)
       .text(text, marginLeft + pad + 48, dy, { width: iW - 48 });
    dy += 14;
  });

  // Teal accent line
  doc.rect(marginLeft, y + bandH, W, 2.5).fill(TEAL);
}

function headerHeight(hotel) {
  const detailCount = [hotel.address, hotel.phone, hotel.email].filter(Boolean).length;
  return 34 + Math.max(32, detailCount * 14 + 10) + 2.5 + 8;
}

function drawReceiptFooter(doc, hotel, y, W, marginLeft = 24) {
  const cx = { width: W, align: 'center' };

  // ── Branch contact reminder ───────────────────────────────────────────────
  doc.fontSize(8).font('Helvetica-Bold').fillColor(NAVY)
     .text('Thank you for choosing ' + (hotel.name || 'us') + '!', marginLeft, y, cx);
  y += 13;

  if (hotel.address) {
    doc.fontSize(7.5).font('Helvetica').fillColor(DGREY)
       .text(hotel.address, marginLeft, y, cx);
    y += 11;
  }
  if (hotel.phone) {
    doc.fontSize(7.5).font('Helvetica').fillColor(DGREY)
       .text('Tel: ' + hotel.phone, marginLeft, y, cx);
    y += 11;
  }
  if (hotel.email) {
    doc.fontSize(7.5).font('Helvetica').fillColor(TEAL)
       .text(hotel.email, marginLeft, y, cx);
    y += 13;
  }

  // ── Divider before brand stamp ────────────────────────────────────────────
  doc.rect(marginLeft + W * 0.25, y, W * 0.5, 0.5).fill(MGREY);
  y += 8;

  // ── "Powered by" brand stamp ──────────────────────────────────────────────
  // Small teal pill containing the brand credit
  const stampW = 180;
  const stampX = marginLeft + (W - stampW) / 2;
  doc.rect(stampX, y, stampW, 16).fill(TEAL);
  doc.fontSize(7).font('Helvetica-Bold').fillColor(WHITE)
     .text('Powered by  Anchor Hotel Suite', stampX, y + 5, { width: stampW, align: 'center' });
}

function divider(doc, y, W, marginLeft = 24) {
  doc.rect(marginLeft, y, W, 0.75).fill(MGREY);
}

function twoCol(doc, x, y, W, label, value, bold = false, size = 8, valueColor = DGREY) {
  doc.fontSize(size).font('Helvetica-Bold').fillColor(NAVY).text(label, x, y, { width: W * 0.42 });
  doc.fontSize(size).font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(valueColor)
     .text(value, x + W * 0.44, y, { width: W * 0.56, align: 'right' });
}

function chargeRow(doc, x, y, W, label, amount) {
  doc.fontSize(8).font('Helvetica').fillColor(DGREY).text(label, x + 4, y, { width: W * 0.7 });
  doc.text(fmt(amount), x, y, { width: W - 4, align: 'right' });
}

function fmt(amount) {
  return '₦' + Number(amount).toLocaleString('en-NG', { minimumFractionDigits: 2 });
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-NG', {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// EMAIL HELPER
// ═════════════════════════════════════════════════════════════════════════════

async function emailReceipt({ email, hotel, subject, pdfBuffer, filename }) {
  if (!process.env.SMTP_HOST) {
    console.log(`[Receipt Email] SMTP not configured. Would have sent "${filename}" to ${email}`);
    return { success: false, error: 'SMTP not configured' };
  }

  try {
    const port    = parseInt(process.env.SMTP_PORT || '587');
    const secure  = process.env.SMTP_SECURE === 'true' || port === 465;

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port, secure,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 10000,
      socketTimeout: 15000,
      tls: { rejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== 'false' },
    });

    await transporter.verify();

    await transporter.sendMail({
      from: `"${hotel.name}" <${process.env.SMTP_FROM || hotel.email || 'noreply@anchorhotelsuite.com'}>`,
      to: email,
      subject,
      text: `Please find your receipt attached from ${hotel.name}.\n\n${hotel.address || ''}\n${hotel.phone || ''}\n${hotel.email || ''}`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:auto;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
          <div style="background:#1A3A5C;padding:20px 24px;">
            <h2 style="color:#fff;margin:0;font-size:1.2rem;">🏨 ${hotel.name}</h2>
            ${hotel.address ? `<p style="color:#93C5FD;font-size:0.8rem;margin:4px 0 0;">${hotel.address}</p>` : ''}
          </div>
          <div style="padding:20px 24px;">
            <p>Dear Guest,</p>
            <p>Please find your receipt attached to this email.</p>
            <p>For any queries, feel free to reach us:</p>
            ${hotel.email ? `<p>📧 <a href="mailto:${hotel.email}">${hotel.email}</a></p>` : ''}
            ${hotel.phone ? `<p>📞 ${hotel.phone}</p>` : ''}
            <hr style="border:1px solid #e2e8f0;margin:16px 0;">
            <p style="color:#94A3B8;font-size:0.75rem;">
              This is an automated receipt from Anchor Hotel Suite.
            </p>
          </div>
        </div>`,
      attachments: [{
        filename,
        content: pdfBuffer,
        contentType: 'application/pdf',
      }],
    });

    console.log(`[Receipt Email] Sent "${filename}" to ${email}`);
    return { success: true };
  } catch (err) {
    console.error(`[Receipt Email ERROR] ${err.message}`);
    return { success: false, error: err.message };
  }
}

// Convert a PDFDocument stream to a Buffer (for email attachments)
function streamToBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}


// ═════════════════════════════════════════════════════════════════════════════
// EXPORTED HELPER — called by roomLogs.js on checkout and send-receipt
// ═════════════════════════════════════════════════════════════════════════════

/**
 * sendRoomReceiptByLogId
 * Fetches the full room log, builds the PDF, and emails it.
 * Returns { sent: bool, error: string|null }
 */
export async function sendRoomReceiptByLogId(roomLogId, recipientEmail) {
  try {
    const log = await prisma.roomLog.findUnique({
      where: { id: roomLogId },
      include: {
        room:         true,
        hotel:        true,
        createdBy:    { select: { name: true } },
        transactions: { orderBy: { createdAt: 'asc' } },
        creditLedger: { orderBy: { date:      'asc' } },
        posSales:     { include: { items: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!log) return { sent: false, error: 'Room log not found' };

    const filename = `Stay-Receipt-${log.guestName.replace(/\s+/g, '-')}-${log.id.slice(-8).toUpperCase()}.pdf`;

    return await emailReceipt({
      email:     recipientEmail,
      hotel:     log.hotel,
      subject:   `Your stay receipt from ${log.hotel.name}`,
      pdfBuffer: await streamToBuffer(buildRoomReceipt(log)),
      filename,
    });
  } catch (err) {
    console.error('[sendRoomReceiptByLogId]', err.message);
    return { sent: false, error: err.message };
  }
}

export default router;
