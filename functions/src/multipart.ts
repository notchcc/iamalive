/**
 * 以 busboy 解析 multipart/form-data（Cloud Functions 已把 body 讀進 req.rawBody）。
 */
import Busboy from 'busboy';
import type { Request } from 'express';

export interface ParsedMultipart {
  fields: Record<string, string>;
  file: { field: string; filename: string; mimeType: string; data: Buffer } | null;
}

export function parseMultipart(req: Request, maxFileBytes: number): Promise<ParsedMultipart> {
  return new Promise((resolve, reject) => {
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!raw) {
      reject(new Error('NO_RAW_BODY'));
      return;
    }
    const bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: maxFileBytes, fields: 20, fieldSize: 4096 } });
    const out: ParsedMultipart = { fields: {}, file: null };
    let tooLarge = false;

    bb.on('field', (name, val) => {
      out.fields[name] = val;
    });
    bb.on('file', (field, stream, info) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('limit', () => {
        tooLarge = true;
      });
      stream.on('end', () => {
        out.file = { field, filename: info.filename, mimeType: info.mimeType, data: Buffer.concat(chunks) };
      });
    });
    bb.on('error', reject);
    bb.on('finish', () => {
      if (tooLarge) reject(new Error('FILE_TOO_LARGE'));
      else resolve(out);
    });
    bb.end(raw);
  });
}
