import { Router, Response } from 'express';
import PDFDocument from 'pdfkit';
import { Types } from 'mongoose';
import { AuthRequest } from '../middleware/auth';
import { HealthProfile } from '../models/HealthProfile';
import { CabinetItem } from '../models/CabinetItem';
import { SideEffect } from '../models/SideEffect';
import { checkCabinetInteractions, Interaction } from '../services/interactionChecker';

const router = Router();

// Helpers
function or(val: unknown, fallback = 'Not provided'): string {
  if (val === undefined || val === null || val === '') return fallback;
  if (Array.isArray(val)) return val.length === 0 ? fallback : val.join(', ');
  return String(val);
}

function sectionTitle(doc: PDFKit.PDFDocument, title: string) {
  doc
    .moveDown(0.5)
    .font('Helvetica-Bold')
    .fontSize(13)
    .fillColor('#1a1a1a')
    .text(title);
  doc.moveTo(doc.page.margins.left, doc.y + 2)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y + 2)
    .strokeColor('#cccccc')
    .lineWidth(0.5)
    .stroke();
  doc.moveDown(0.4);
  doc.font('Helvetica').fontSize(10).fillColor('#333333');
}

function kv(doc: PDFKit.PDFDocument, label: string, value: string) {
  doc.font('Helvetica-Bold').fontSize(10).text(`${label}: `, { continued: true });
  doc.font('Helvetica').fontSize(10).text(value);
}

function tableRow(
  doc: PDFKit.PDFDocument,
  cols: string[],
  widths: number[],
  x: number,
  isHeader = false
) {
  const y = doc.y;
  let cx = x;
  doc.font(isHeader ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
  for (let i = 0; i < cols.length; i++) {
    doc.text(cols[i] ?? '', cx + 3, y, { width: widths[i] - 6, lineBreak: false });
    cx += widths[i];
  }
  // Advance by row height (approx 14pt)
  doc.y = y + 14;
}

// GET /export/pdf
router.get('/pdf', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = new Types.ObjectId(req.userId);

  const [profile, cabinetItems, sideEffects] = await Promise.all([
    HealthProfile.findOne({ userId }).lean(),
    CabinetItem.find({ userId, active: true }).sort({ name: 1 }).lean(),
    SideEffect.find({ userId }).sort({ date: -1 }).limit(30).lean(),
  ]);

  // Resolve supplement names for side effects
  const allItemIds = [...new Set(sideEffects.map((s) => s.cabinetItemId.toString()))];
  const allItems = await CabinetItem.find({ _id: { $in: allItemIds } }).lean();
  const itemNameMap = new Map(allItems.map((i) => [(i._id as Types.ObjectId).toString(), i.name]));

  // Fetch interactions (non-fatal)
  let interactions: Interaction[] = [];
  try {
    interactions = await checkCabinetInteractions(cabinetItems as Parameters<typeof checkCabinetInteractions>[0]);
  } catch {
    // swallow — interactions are best-effort
  }

  // Build wellness score (deterministic part only — no AI on export)
  const profileScore = (() => {
    if (!profile) return 0;
    const fields = [
      profile.body?.height, profile.body?.weight, profile.body?.age, profile.body?.sex,
      profile.diet?.dietType, profile.exercise?.frequency, profile.sleep?.quality,
      profile.lifestyle?.stressLevel, profile.goals?.primary,
    ];
    const filled = fields.filter((f) => f !== undefined && f !== null && String(f).trim() !== '' && !(Array.isArray(f) && f.length === 0)).length;
    return Math.round((filled / fields.length) * 40);
  })();

  // ── Build PDF ─────────────────────────────────────────────────────────────
  const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="recallth-health-report.pdf"');
  doc.pipe(res);

  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const leftX = doc.page.margins.left;

  // ── 1. Header ────────────────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#16a34a').text('Recallth Health Report', leftX);
  doc.font('Helvetica').fontSize(10).fillColor('#555555')
    .text(`Generated: ${new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })}`)
    .moveDown(0.2);
  doc.font('Helvetica').fontSize(9).fillColor('#888888')
    .text('This report is for personal use only. It is not a substitute for professional medical advice.');
  doc.moveDown(0.8);

  // ── 2. Health Profile ────────────────────────────────────────────────────
  sectionTitle(doc, '1. Health Profile');

  if (!profile) {
    doc.text('No health profile found.');
  } else {
    const b = profile.body ?? {};
    const d = profile.diet ?? {};
    const e = profile.exercise ?? {};
    const s = profile.sleep ?? {};
    const l = profile.lifestyle ?? {};
    const g = profile.goals ?? {};
    const bw = profile.bloodwork ?? {};

    doc.font('Helvetica-Bold').fontSize(10).text('Body');
    doc.font('Helvetica').fontSize(10);
    kv(doc, 'Height', or(b.height ? `${b.height} cm` : ''));
    kv(doc, 'Weight', or(b.weight ? `${b.weight} kg` : ''));
    kv(doc, 'Age', or(b.age));
    kv(doc, 'Sex', or(b.sex));
    kv(doc, 'Body goals', or(b.bodyCompositionGoals));
    doc.moveDown(0.3);

    doc.font('Helvetica-Bold').fontSize(10).text('Diet');
    kv(doc, 'Diet type', or(d.dietType));
    kv(doc, 'Preferences', or(d.preferences));
    kv(doc, 'Allergies', or(d.allergies));
    kv(doc, 'Intolerances', or(d.intolerances));
    doc.moveDown(0.3);

    doc.font('Helvetica-Bold').fontSize(10).text('Exercise');
    kv(doc, 'Type', or(e.type));
    kv(doc, 'Frequency', or(e.frequency));
    kv(doc, 'Intensity', or(e.intensity));
    kv(doc, 'Goals', or(e.goals));
    doc.moveDown(0.3);

    doc.font('Helvetica-Bold').fontSize(10).text('Sleep');
    kv(doc, 'Schedule', or(s.schedule));
    kv(doc, 'Quality', or(s.quality));
    kv(doc, 'Issues', or(s.issues));
    doc.moveDown(0.3);

    doc.font('Helvetica-Bold').fontSize(10).text('Lifestyle');
    kv(doc, 'Stress level', or(l.stressLevel));
    kv(doc, 'Work type', or(l.workType));
    kv(doc, 'Alcohol', or(l.alcohol));
    kv(doc, 'Smoking', or(l.smoking));
    doc.moveDown(0.3);

    doc.font('Helvetica-Bold').fontSize(10).text('Goals');
    kv(doc, 'Primary goals', or(g.primary));
    doc.moveDown(0.3);

    const bwFields = [
      ['HbA1c', bw.hba1c ? `${bw.hba1c}%` : null],
      ['Total cholesterol', bw.totalCholesterol ? `${bw.totalCholesterol} mmol/L` : null],
      ['LDL', bw.ldl ? `${bw.ldl} mmol/L` : null],
      ['HDL', bw.hdl ? `${bw.hdl} mmol/L` : null],
      ['Triglycerides', bw.triglycerides ? `${bw.triglycerides} mmol/L` : null],
      ['Fasting glucose', bw.fastingGlucose ? `${bw.fastingGlucose} mmol/L` : null],
      ['Ferritin', bw.ferritin ? `${bw.ferritin} ng/mL` : null],
      ['Vitamin D', bw.vitaminD ? `${bw.vitaminD} nmol/L` : null],
      ['Vitamin B12', bw.vitaminB12 ? `${bw.vitaminB12} pmol/L` : null],
      ['TSH', bw.tsh ? `${bw.tsh} mIU/L` : null],
    ].filter(([, v]) => v !== null) as [string, string][];

    if (bwFields.length > 0) {
      doc.font('Helvetica-Bold').fontSize(10).text('Bloodwork');
      for (const [label, val] of bwFields) kv(doc, label, val);
      if (bw.testedAt) kv(doc, 'Tested at', bw.testedAt);
    }
  }

  // ── 3. Supplement Cabinet ────────────────────────────────────────────────
  sectionTitle(doc, '2. Supplement Cabinet (Active)');

  if (cabinetItems.length === 0) {
    doc.text('No supplements added.');
  } else {
    const colWidths = [140, 75, 75, 80, 80, 80];
    const headers = ['Name', 'Type', 'Dosage', 'Frequency', 'Timing', 'Brand'];
    tableRow(doc, headers, colWidths, leftX, true);
    doc.moveTo(leftX, doc.y).lineTo(leftX + pageWidth, doc.y).strokeColor('#cccccc').lineWidth(0.5).stroke();

    for (const item of cabinetItems) {
      if (doc.y > doc.page.height - 100) {
        doc.addPage();
        tableRow(doc, headers, colWidths, leftX, true);
        doc.moveTo(leftX, doc.y).lineTo(leftX + pageWidth, doc.y).strokeColor('#cccccc').lineWidth(0.5).stroke();
      }
      tableRow(doc, [
        item.name,
        item.type,
        or(item.dosage, '—'),
        or(item.frequency, '—'),
        or(item.timing, '—'),
        or(item.brand, '—'),
      ], colWidths, leftX);
    }
  }

  // ── 4. Side Effects Log ──────────────────────────────────────────────────
  sectionTitle(doc, '3. Side Effects Log (Last 30)');

  if (sideEffects.length === 0) {
    doc.text('No reactions logged.');
  } else {
    const colWidths = [140, 160, 60, 100];
    const headers = ['Supplement', 'Symptom', 'Severity', 'Date'];
    tableRow(doc, headers, colWidths, leftX, true);
    doc.moveTo(leftX, doc.y).lineTo(leftX + pageWidth, doc.y).strokeColor('#cccccc').lineWidth(0.5).stroke();

    for (const se of sideEffects) {
      if (doc.y > doc.page.height - 100) {
        doc.addPage();
        tableRow(doc, headers, colWidths, leftX, true);
        doc.moveTo(leftX, doc.y).lineTo(leftX + pageWidth, doc.y).strokeColor('#cccccc').lineWidth(0.5).stroke();
      }
      const suppName = itemNameMap.get(se.cabinetItemId.toString()) ?? 'Unknown';
      tableRow(doc, [
        suppName,
        se.symptom,
        `${se.rating}/5`,
        new Date(se.date).toLocaleDateString('en-GB'),
      ], colWidths, leftX);
    }
  }

  // ── 5. Wellness Score ────────────────────────────────────────────────────
  sectionTitle(doc, '4. Wellness Score');
  doc.text(`Profile Completeness Score (deterministic): ${profileScore}/40`);
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(9).fillColor('#888888')
    .text('Note: Goal Alignment score requires the live app. See dashboard for full score.');
  doc.fillColor('#333333').fontSize(10);

  // ── 6. Detected Interactions ─────────────────────────────────────────────
  sectionTitle(doc, '5. Detected Interactions');

  if (interactions.length === 0) {
    doc.text('No interactions detected.');
  } else {
    for (const interaction of interactions) {
      doc.font('Helvetica-Bold').fontSize(10)
        .text(`${interaction.item1} + ${interaction.item2}`, { continued: true });
      doc.font('Helvetica').text(` (${interaction.severity})`);
      doc.font('Helvetica').fontSize(9).fillColor('#555555').text(interaction.description);
      doc.fillColor('#333333').fontSize(10).moveDown(0.3);
    }
  }

  // ── Footer on all pages ───────────────────────────────────────────────────
  const pageCount = (doc.bufferedPageRange().count);
  for (let i = 0; i < pageCount; i++) {
    doc.switchToPage(i);
    doc.font('Helvetica').fontSize(8).fillColor('#aaaaaa')
      .text(
        'This report was generated by Recallth. It is not medical advice. Always consult a qualified healthcare professional.',
        doc.page.margins.left,
        doc.page.height - 40,
        { width: pageWidth, align: 'center' }
      );
  }

  doc.end();
});

export default router;
