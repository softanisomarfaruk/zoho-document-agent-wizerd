function pdfEscape(text) {
  return String(text || '')
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function wrapWords(text, maxChars) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let current = '';
  words.forEach((word) => {
    const piece = word.length > maxChars ? word.slice(0, maxChars) : word;
    const next = current ? `${current} ${piece}` : piece;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = piece;
    } else {
      current = next;
    }
  });
  if (current) lines.push(current);
  return lines;
}

function markdownToPdfLines(markdown) {
  const lines = [];
  let inCode = false;
  String(markdown || '').replace(/\r\n/g, '\n').split('\n').forEach((line) => {
    if (line.trim().startsWith('```')) {
      inCode = !inCode;
      return;
    }
    if (inCode) {
      lines.push({ kind: 'code', text: line.replace(/\t/g, '  ') });
      return;
    }
    if (!line.trim()) {
      lines.push({ kind: 'blank', text: '' });
      return;
    }
    if (/^[\s|:-]+$/.test(line)) return;
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      lines.push({
        kind: `h${heading[1].length}`,
        text: heading[2].replace(/[*_`]/g, '')
      });
      return;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      lines.push({
        kind: 'li',
        text: line.replace(/^\s*([-*]|\d+\.)\s+/, '').replace(/[*_`]/g, '')
      });
      return;
    }
    lines.push({
      kind: 'p',
      text: line.replace(/^\s*>\s?/, '').replace(/\|/g, '  ').replace(/[*_`]/g, '')
    });
  });
  return lines;
}

function markdownToPdf(markdown) {
  const styles = {
    h1: { size: 16, bold: true, chars: 58, gap: 8 },
    h2: { size: 13, bold: true, chars: 72, gap: 6 },
    h3: { size: 12, bold: true, chars: 78, gap: 4 },
    p: { size: 10, bold: false, chars: 92, gap: 2 },
    li: { size: 10, bold: false, chars: 88, gap: 2 },
    code: { size: 9, bold: false, chars: 90, gap: 1 },
    blank: { size: 8, bold: false, chars: 90, gap: 0 }
  };
  const pageHeight = 842;
  const top = 800;
  const bottom = 48;
  const pages = [[]];
  let y = top;

  markdownToPdfLines(markdown).forEach((block) => {
    const style = styles[block.kind] || styles.p;
    const wrapped = block.kind === 'blank' ? [''] : wrapWords(block.kind === 'li' ? `• ${block.text}` : block.text, style.chars);
    wrapped.forEach((text) => {
      const lineHeight = style.size + style.gap;
      if (y - lineHeight < bottom) {
        pages.push([]);
        y = top;
      }
      pages[pages.length - 1].push({ text, size: style.size, bold: style.bold, y });
      y -= lineHeight;
    });
  });

  if (!pages[0].length) {
    pages[0].push({ text: 'No documentation text was returned.', size: 11, bold: false, y: top });
  }
  return renderPdf(pages);
}

function renderPdf(pages) {
  const pageCount = pages.length;
  const fontRegular = 3 + (pageCount * 2);
  const fontBold = fontRegular + 1;
  const objects = new Array(2 + (pageCount * 2) + 2);

  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = pages.map((_, index) => `${3 + index} 0 R`).join(' ');
  objects[1] = `<< /Type /Pages /Count ${pageCount} /Kids [${kids}] >>`;

  pages.forEach((page, index) => {
    const pageObject = 3 + index;
    const contentObject = 3 + pageCount + index;
    objects[pageObject - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${contentObject} 0 R /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> >>`;
    const commands = ['BT'];
    page.forEach((line) => {
      commands.push(`/${line.bold ? 'F2' : 'F1'} ${line.size} Tf`);
      commands.push(`1 0 0 1 48 ${line.y} Tm`);
      commands.push(`(${pdfEscape(line.text)}) Tj`);
    });
    commands.push('ET');
    const stream = commands.join('\n');
    objects[contentObject - 1] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });

  objects[fontRegular - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  objects[fontBold - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';

  let output = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n`;
  output += '0000000000 65535 f \n';
  for (let index = 1; index < offsets.length; index += 1) {
    output += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return Buffer.from(output, 'latin1');
}

module.exports = { markdownToPdf };
