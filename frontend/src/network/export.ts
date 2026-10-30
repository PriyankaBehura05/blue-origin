// Excel / CSV downloads of dashboard tables, in the TechnoSport report format (the layout of
// Distributor_Counter_Report.xlsx, same as the backend's app/services/excel_report.py):
//   row 1 "TECHNOSPORT  |  <title>" Arial 12 bold, merged, grey rule · row 2 notes, filters and date (Arial 9 italic grey)
//   row 4 header: Arial 10 bold on F2F2F2, thin BFBFBF borders · data: Arial 10, text left, counts centred,
//   ₹ right as ###,##0 (negatives in brackets, zero as –), % green / red · Total columns and TOTAL row on E6E6E6.
// ExcelJS is loaded only when a download is made.
import type { Col, Row, Table } from './types';

const TIERS = ['Untiered', 'Yellow', 'Green', 'Silver', 'Gold', 'Platinum'];
const STATUS: Record<string, string> = { Review: 'Needs review', 'N/A': '' };

type Kind = 'text' | 'num' | 'inr' | 'pct';
const kindOf = (c: Col): Kind =>
  c.type === 'inr' ? 'inr' : c.type === 'pct' || (c.type === 'num' && c.label.includes('%')) ? 'pct' : c.type === 'num' ? 'num' : 'text';

function val(c: Col, r: Row) {
  const v = r[c.k];
  if (c.type === 'tier') return typeof v === 'number' ? (v < 0 ? 'Not listed' : TIERS[v]) : String(v ?? '');
  if (c.type === 'status') return STATUS[String(v)] ?? String(v ?? '');
  const k = kindOf(c);
  if (k === 'pct') return v == null || v === '' ? '' : Number(v) / 100; // values are in percent units
  if (k === 'inr' || k === 'num') return v == null || v === '' ? '' : Math.round(Number(v) * 100) / 100;
  return String(v ?? '');
}

function save(filename: string, blob: Blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}
const clean = (s: string) => s.replace(/[^\w.\- ]+/g, '_');

export function exportCsv(t: Table, stamp: string) {
  const q = (s: unknown) => {
    const x = String(s ?? '');
    return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
  };
  const csv = [t.cols.map((c) => q(c.label)).join(','), ...t.rows.map((r) => t.cols.map((c) => q(val(c, r))).join(','))].join('\n');
  save(clean(`${t.title}_${stamp}.csv`), new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
}

const FONT = 'Arial';
const FMT: Record<Kind, string | undefined> = {
  text: undefined,
  num: '#,##0;\\-#,##0;"–"',
  inr: '###,##0;\\(###,##0\\);"–"',
  pct: '[Green]0.0%;[Red]\\-0.0%;"–"',
};
const ALIGN: Record<Kind, 'left' | 'center' | 'right'> = { text: 'left', num: 'center', inr: 'right', pct: 'center' };
const fill = (argb: string) => ({ type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb } });
const thin = { style: 'thin' as const, color: { argb: 'FFBFBFBF' } };
const BORDER = { left: thin, right: thin, top: thin, bottom: thin };
const SHADED = /^(total|fy total|peak|lifetime)\b/i;
const NOT_SUMMED = /%|rate|\bid\b|pincode|phone/i;
const HEADER = 4;

export async function exportXlsx(tables: Table[], stamp: string, filters: string, filename?: string) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TechnoSport – Blue Origin';
  const used = new Set<string>();
  const generated = new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  for (const t of tables) {
    const base = t.title.replace(/[\\/*?:[\]]/g, '-');
    let name = base.slice(0, 31);
    for (let k = 2; used.has(name); k++) name = `${base.slice(0, 26)} (${k})`;
    used.add(name);
    const n = Math.max(t.cols.length, 1);
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', xSplit: 1, ySplit: HEADER }] });
    const kinds = t.cols.map(kindOf);

    ws.getCell(1, 1).value = `TECHNOSPORT  |  ${t.title}`;
    ws.getCell(1, 1).font = { name: FONT, size: 12, bold: true, color: { argb: 'FF1A1A1A' } };
    ws.getCell(1, 1).alignment = { horizontal: 'left', vertical: 'middle' };
    ws.getRow(1).height = 24;
    for (let c = 1; c <= n; c++) ws.getCell(1, c).border = { bottom: { style: 'medium', color: { argb: 'FF808080' } } };
    ws.getCell(2, 1).value = [t.caption, `Filters: ${filters}`, `Revenue in ₹`, `Generated ${generated}`].filter(Boolean).join('  •  ');
    ws.getCell(2, 1).font = { name: FONT, size: 9, italic: true, color: { argb: 'FF777777' } };
    if (n > 1) {
      ws.mergeCells(1, 1, 1, n);
      ws.mergeCells(2, 1, 2, n);
    }

    const head = ws.getRow(HEADER);
    t.cols.forEach((c, j) => {
      const cell = head.getCell(j + 1);
      cell.value = c.label;
      cell.font = { name: FONT, size: 10, bold: true, color: { argb: 'FF1A1A1A' } };
      cell.fill = fill(SHADED.test(c.label) ? 'FFE6E6E6' : 'FFF2F2F2');
      cell.border = BORDER;
      cell.alignment = { horizontal: j === 0 ? 'left' : 'center', vertical: 'middle', wrapText: true };
    });
    head.height = 26.4;

    const first = HEADER + 1;
    t.rows.forEach((r, i) => {
      const row = ws.getRow(first + i);
      t.cols.forEach((c, j) => {
        const cell = row.getCell(j + 1);
        const v = val(c, r);
        cell.value = v === '' ? null : v;
        const shaded = SHADED.test(c.label);
        cell.font = { name: FONT, size: 10, bold: shaded, color: { argb: 'FF000000' } };
        if (shaded) cell.fill = fill('FFE6E6E6');
        cell.border = BORDER;
        cell.alignment = { horizontal: ALIGN[kinds[j]], vertical: 'middle', wrapText: c.type === 'wrap' };
        const fmt = FMT[kinds[j]];
        if (fmt) cell.numFmt = fmt;
      });
    });
    const end = first + t.rows.length - 1;

    if (t.total && t.rows.length) {
      const row = ws.getRow(end + 1);
      t.cols.forEach((c, j) => {
        const cell = row.getCell(j + 1);
        const col = ws.getColumn(j + 1).letter;
        if (j === 0) cell.value = 'TOTAL';
        else if ((kinds[j] === 'num' || kinds[j] === 'inr') && !NOT_SUMMED.test(c.label)) {
          cell.value = { formula: `SUM(${col}${first}:${col}${end})` };
          cell.numFmt = FMT[kinds[j]]!;
        }
        cell.font = { name: FONT, size: 10, bold: true, color: { argb: 'FF000000' } };
        cell.fill = fill('FFE6E6E6');
        cell.border = BORDER;
        cell.alignment = { horizontal: j === 0 ? 'left' : ALIGN[kinds[j]], vertical: 'middle' };
      });
    } else if (t.rows.length && !t.matrix) {
      ws.autoFilter = { from: { row: HEADER, column: 1 }, to: { row: end, column: n } };
    }

    t.cols.forEach((c, j) => {
      const sample = t.rows.slice(0, 300).map((r) => String(val(c, r)).length);
      const width = Math.max(c.label.length * 0.9, ...sample) + 2;
      ws.getColumn(j + 1).width = c.w ?? Math.max(9, Math.min(j === 0 ? Math.max(width, 24) : width, 48));
    });
  }
  const buf = await wb.xlsx.writeBuffer();
  save(clean(filename ?? `${tables.length > 1 ? 'BO_Report_Pack' : tables[0].title}_${stamp}.xlsx`),
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
}
