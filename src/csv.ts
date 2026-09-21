/**
 * Parses a CSV document using the RFC-4180 quoting rules required by the fixtures.
 *
 * This intentionally has no implicit column mapping: source-specific contract
 * validation happens later, where an incompatible header can be quarantined.
 * @param text Complete UTF-8 CSV document.
 * @returns Rows keyed by their header values.
 * @throws When the header is malformed, quotes are unterminated, or a row has a different width.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const cells: string[][] = []; let row: string[] = []; let field = ''; let quote = false;
  
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quote = false; else field += c; continue; }
    if (c === '"') quote = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); cells.push(row); row = []; field = ''; }
    else field += c;
  }

  if (quote) throw new Error('Unterminated CSV quote');
  
  if (field || row.length) { row.push(field.replace(/\r$/, '')); cells.push(row); }
  
  const [headers, ...rows] = cells;

  if (!headers?.length) throw new Error('CSV has no header');

  if (new Set(headers).size !== headers.length || headers.some((h) => !h)) 
    throw new Error('CSV header is invalid');
  
  return rows.filter((r) => r.some(Boolean)).map((r, index) => {
    if (r.length !== headers.length) throw new Error(`CSV row ${index + 2} has ${r.length} fields; expected ${headers.length}`);
    return Object.fromEntries(headers.map((header, i) => [header, r[i]]));
  });
}
