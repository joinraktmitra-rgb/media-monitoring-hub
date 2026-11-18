import fsp from "node:fs/promises";
import path from "node:path";
import { fetchWithRetry } from "./http.ts";

export interface JpegInfo {
  width: number;
  height: number;
  components: number;
}

/**
 * Parse width, height, and color components from a raw JPEG buffer (SOF markers).
 */
export function parseJpegInfo(buf: Uint8Array): JpegInfo {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    throw new Error("Invalid JPEG header (missing 0xFFD8 SOI marker)");
  }

  let offset = 2;
  while (offset + 4 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    while (offset < buf.length && buf[offset] === 0xff) {
      offset++;
    }
    if (offset >= buf.length) break;

    const marker = buf[offset];
    offset++;

    // Standalone markers without length
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      continue;
    }

    if (offset + 2 > buf.length) break;
    const segLen = (buf[offset] << 8) | buf[offset + 1];
    if (segLen < 2 || offset + segLen > buf.length) break;

    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isSof && offset + 7 < buf.length) {
      const height = (buf[offset + 3] << 8) | buf[offset + 4];
      const width = (buf[offset + 5] << 8) | buf[offset + 6];
      const components = buf[offset + 7];
      if (width > 0 && height > 0) {
        return { width, height, components };
      }
    }

    offset += segLen;
  }

  throw new Error("Could not find SOF dimensions in JPEG buffer");
}

/**
 * Assemble an array of raw JPEG buffers into a valid PDF 1.4 binary using native DCTDecode.
 * Zero external dependencies and zero recompression.
 */
export function buildPdfFromJpegs(jpegs: Uint8Array[]): Uint8Array {
  if (jpegs.length === 0) {
    throw new Error("Cannot build PDF from empty image list");
  }

  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [0]; // object 0 is free
  let bytePos = 0;

  const pushBytes = (bytes: Uint8Array): void => {
    chunks.push(bytes);
    bytePos += bytes.length;
  };
  const pushStr = (s: string): void => {
    pushBytes(encoder.encode(s));
  };

  pushStr("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

  const pageCount = jpegs.length;
  // Object IDs:
  // 1: Catalog
  // 2: Pages
  // For each page i (0..pageCount-1):
  //   pageObjId    = 3 + i * 3
  //   contentObjId = 4 + i * 3
  //   imageObjId   = 5 + i * 3
  const pageIds = Array.from({ length: pageCount }, (_, i) => `${3 + i * 3} 0 R`).join(" ");

  // Obj 1: Catalog
  offsets.push(bytePos);
  pushStr("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  // Obj 2: Pages
  offsets.push(bytePos);
  pushStr(`2 0 obj\n<< /Type /Pages /Kids [ ${pageIds} ] /Count ${pageCount} >>\nendobj\n`);

  for (let i = 0; i < pageCount; i++) {
    const jpeg = jpegs[i];
    const { width, height, components } = parseJpegInfo(jpeg);
    const colorSpace = components === 1 ? "/DeviceGray" : components === 4 ? "/DeviceCMYK" : "/DeviceRGB";

    const pageObjId = 3 + i * 3;
    const contentObjId = 4 + i * 3;
    const imageObjId = 5 + i * 3;

    // Scale page width/height to points (72 dpi equivalent, capped cleanly)
    const ptW = width;
    const ptH = height;
    const contentStream = `q\n${ptW} 0 0 ${ptH} 0 0 cm\n/Im0 Do\nQ\n`;

    // Page object
    offsets.push(bytePos);
    pushStr(
      `${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 ${ptW} ${ptH} ] /Resources << /XObject << /Im0 ${imageObjId} 0 R >> >> /Contents ${contentObjId} 0 R >>\nendobj\n`
    );

    // Content stream object
    offsets.push(bytePos);
    pushStr(
      `${contentObjId} 0 obj\n<< /Length ${contentStream.length} >>\nstream\n${contentStream}endstream\nendobj\n`
    );

    // Image XObject (raw JPEG DCTDecode)
    offsets.push(bytePos);
    pushStr(
      `${imageObjId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`
    );
    pushBytes(jpeg);
    pushStr("\nendstream\nendobj\n");
  }

  const xrefPos = bytePos;
  const totalObjects = offsets.length;
  pushStr(`xref\n0 ${totalObjects}\n`);
  pushStr("0000000000 65535 f \n");
  for (let i = 1; i < totalObjects; i++) {
    pushStr(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  }

  pushStr(
    `trailer\n<< /Size ${totalObjects} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  );

  const output = new Uint8Array(bytePos);
  let cursor = 0;
  for (const chunk of chunks) {
    output.set(chunk, cursor);
    cursor += chunk.length;
  }
  return output;
}

export interface BuildPdfResult {
  filePath: string;
  sizeBytes: number;
  sizeMB: number;
  pages: number;
}

/**
 * Concurrently download JPEG page images and atomically write an assembled PDF.
 */
export async function downloadImagesToPdf(
  imageUrls: string[],
  targetPath: string,
  concurrency = 8
): Promise<BuildPdfResult> {
  if (imageUrls.length === 0) {
    throw new Error("No page image URLs provided.");
  }

  const results = new Array<Uint8Array>(imageUrls.length);
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (nextIdx < imageUrls.length) {
      const idx = nextIdx++;
      const url = imageUrls[idx];
      const res = await fetchWithRetry(url);
      if (!res.ok) {
        throw new Error(`Failed to fetch page ${idx + 1} (${url}): HTTP ${res.status}`);
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      results[idx] = buf;
    }
  }

  const workerCount = Math.min(concurrency, imageUrls.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const pdfBytes = buildPdfFromJpegs(results);
  const resolved = path.resolve(targetPath);
  await fsp.mkdir(path.dirname(resolved), { recursive: true });
  const partPath = `${resolved}.part`;
  await fsp.writeFile(partPath, pdfBytes);
  await fsp.rename(partPath, resolved);

  return {
    filePath: resolved,
    sizeBytes: pdfBytes.length,
    sizeMB: Number((pdfBytes.length / (1024 * 1024)).toFixed(2)),
    pages: results.length,
  };
}
