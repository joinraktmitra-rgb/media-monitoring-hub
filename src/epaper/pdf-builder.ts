import fsp from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
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

export interface JpegTile {
  tx: number;
  ty: number;
  width: number;
  height: number;
  jpeg: Uint8Array;
}

export interface TiledJpegPage {
  width: number;
  height: number;
  tiles: JpegTile[];
}

export interface TiledPageSpec {
  width: number;
  height: number;
  tiles: Array<{
    tx: number;
    ty: number;
    width: number;
    height: number;
    url: string;
  }>;
}

/**
 * Assemble tiled JPEG pages into a valid PDF 1.4 binary using native DCTDecode compositing.
 * Each tile is placed at its exact PDF coordinates without re-encoding or image stitching.
 */
export function buildPdfFromTiledJpegs(pages: TiledJpegPage[]): Uint8Array {
  if (pages.length === 0) {
    throw new Error("Cannot build PDF from empty tiled page list");
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

  // Pre-assign object IDs:
  // 1: Catalog, 2: Pages
  // For each page: pageObjId, contentObjId, followed by 1 imageObjId per tile.
  let nextId = 3;
  const pageLayouts = pages.map((page) => {
    const pageObjId = nextId++;
    const contentObjId = nextId++;
    const tileObjIds = page.tiles.map(() => nextId++);
    return { page, pageObjId, contentObjId, tileObjIds };
  });

  pushStr("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

  const pageIds = pageLayouts.map((p) => `${p.pageObjId} 0 R`).join(" ");

  // Obj 1: Catalog
  offsets.push(bytePos);
  pushStr("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  // Obj 2: Pages
  offsets.push(bytePos);
  pushStr(`2 0 obj\n<< /Type /Pages /Kids [ ${pageIds} ] /Count ${pages.length} >>\nendobj\n`);

  for (const { page, pageObjId, contentObjId, tileObjIds } of pageLayouts) {
    const xObjectEntries = tileObjIds.map((id, idx) => `/Im${idx} ${id} 0 R`).join(" ");
    const drawOps: string[] = [];

    for (let t = 0; t < page.tiles.length; t++) {
      const tile = page.tiles[t];
      // PDF origin is bottom-left; Readwhere tile origin (tx, ty) is top-left.
      const pdfX = tile.tx;
      const pdfY = page.height - tile.ty - tile.height;
      drawOps.push(`q\n${tile.width} 0 0 ${tile.height} ${pdfX} ${pdfY} cm\n/Im${t} Do\nQ`);
    }
    const contentStream = `${drawOps.join("\n")}\n`;

    // Page object
    offsets.push(bytePos);
    pushStr(
      `${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 ${page.width} ${page.height} ] /Resources << /XObject << ${xObjectEntries} >> >> /Contents ${contentObjId} 0 R >>\nendobj\n`
    );

    // Content stream object
    offsets.push(bytePos);
    pushStr(
      `${contentObjId} 0 obj\n<< /Length ${contentStream.length} >>\nstream\n${contentStream}endstream\nendobj\n`
    );

    // Tile Image XObjects
    for (let t = 0; t < page.tiles.length; t++) {
      const tile = page.tiles[t];
      const info = parseJpegInfo(tile.jpeg);
      const colorSpace =
        info.components === 1 ? "/DeviceGray" : info.components === 4 ? "/DeviceCMYK" : "/DeviceRGB";
      offsets.push(bytePos);
      pushStr(
        `${tileObjIds[t]} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode /Length ${tile.jpeg.length} >>\nstream\n`
      );
      pushBytes(tile.jpeg);
      pushStr("\nendstream\nendobj\n");
    }
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

/**
 * Concurrently download tiled JPEG pages and atomically write a composited PDF.
 */
export async function downloadTiledPagesToPdf(
  pageSpecs: TiledPageSpec[],
  targetPath: string,
  concurrency = 12
): Promise<BuildPdfResult> {
  if (pageSpecs.length === 0) {
    throw new Error("No tiled page specs provided.");
  }

  const flatJobs: Array<{ pageIdx: number; tileIdx: number; url: string }> = [];
  const tiledPages: TiledJpegPage[] = pageSpecs.map((spec, pageIdx) => ({
    width: spec.width,
    height: spec.height,
    tiles: spec.tiles.map((t, tileIdx) => {
      flatJobs.push({ pageIdx, tileIdx, url: t.url });
      return {
        tx: t.tx,
        ty: t.ty,
        width: t.width,
        height: t.height,
        jpeg: new Uint8Array(0),
      };
    }),
  }));

  let nextIdx = 0;
  async function worker(): Promise<void> {
    while (nextIdx < flatJobs.length) {
      const job = flatJobs[nextIdx++];
      const res = await fetchWithRetry(job.url);
      if (!res.ok) {
        throw new Error(
          `Failed to fetch tile p${job.pageIdx + 1}t${job.tileIdx + 1} (${job.url}): HTTP ${res.status}`
        );
      }
      tiledPages[job.pageIdx].tiles[job.tileIdx].jpeg = new Uint8Array(await res.arrayBuffer());
    }
  }

  const workerCount = Math.min(concurrency, flatJobs.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const pdfBytes = buildPdfFromTiledJpegs(tiledPages);
  const resolved = path.resolve(targetPath);
  await fsp.mkdir(path.dirname(resolved), { recursive: true });
  const partPath = `${resolved}.part`;
  await fsp.writeFile(partPath, pdfBytes);
  await fsp.rename(partPath, resolved);

  return {
    filePath: resolved,
    sizeBytes: pdfBytes.length,
    sizeMB: Number((pdfBytes.length / (1024 * 1024)).toFixed(2)),
    pages: tiledPages.length,
  };
}

/**
 * Concurrently download PNG (or mixed PNG/JPEG) page images and assemble a PDF via pdf-lib.
 */
export async function downloadPngsToPdf(
  imageUrls: string[],
  targetPath: string,
  concurrency = 8
): Promise<BuildPdfResult> {
  if (imageUrls.length === 0) {
    throw new Error("No page image URLs provided.");
  }

  const buffers = new Array<Uint8Array>(imageUrls.length);
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (nextIdx < imageUrls.length) {
      const idx = nextIdx++;
      const url = imageUrls[idx];
      const res = await fetchWithRetry(url);
      if (!res.ok) {
        throw new Error(`Failed to fetch page ${idx + 1} (${url}): HTTP ${res.status}`);
      }
      buffers[idx] = new Uint8Array(await res.arrayBuffer());
    }
  }

  const workerCount = Math.min(concurrency, imageUrls.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const pdfDoc = await PDFDocument.create();
  for (let i = 0; i < buffers.length; i++) {
    const buf = buffers[i];
    const isJpeg = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8;
    const img = isJpeg ? await pdfDoc.embedJpg(buf) : await pdfDoc.embedPng(buf);
    const page = pdfDoc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }

  const pdfBytes = await pdfDoc.save();
  const resolved = path.resolve(targetPath);
  await fsp.mkdir(path.dirname(resolved), { recursive: true });
  const partPath = `${resolved}.part`;
  await fsp.writeFile(partPath, pdfBytes);
  await fsp.rename(partPath, resolved);

  return {
    filePath: resolved,
    sizeBytes: pdfBytes.length,
    sizeMB: Number((pdfBytes.length / (1024 * 1024)).toFixed(2)),
    pages: buffers.length,
  };
}

/**
 * Concurrently download per-page PDF files and merge them into a single master PDF via pdf-lib.
 */
export async function mergePdfUrlsToPdf(
  pdfUrls: string[],
  targetPath: string,
  concurrency = 6
): Promise<BuildPdfResult> {
  if (pdfUrls.length === 0) {
    throw new Error("No page PDF URLs provided.");
  }

  const buffers = new Array<Uint8Array>(pdfUrls.length);
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (nextIdx < pdfUrls.length) {
      const idx = nextIdx++;
      const url = pdfUrls[idx];
      const res = await fetchWithRetry(url);
      if (!res.ok) {
        throw new Error(`Failed to fetch PDF page ${idx + 1} (${url}): HTTP ${res.status}`);
      }
      buffers[idx] = new Uint8Array(await res.arrayBuffer());
    }
  }

  const workerCount = Math.min(concurrency, pdfUrls.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const master = await PDFDocument.create();
  let totalPages = 0;
  for (const buf of buffers) {
    const src = await PDFDocument.load(buf, { ignoreEncryption: true });
    const copied = await master.copyPages(src, src.getPageIndices());
    for (const p of copied) {
      master.addPage(p);
      totalPages++;
    }
  }

  const pdfBytes = await master.save();
  const resolved = path.resolve(targetPath);
  await fsp.mkdir(path.dirname(resolved), { recursive: true });
  const partPath = `${resolved}.part`;
  await fsp.writeFile(partPath, pdfBytes);
  await fsp.rename(partPath, resolved);

  return {
    filePath: resolved,
    sizeBytes: pdfBytes.length,
    sizeMB: Number((pdfBytes.length / (1024 * 1024)).toFixed(2)),
    pages: totalPages,
  };
}
