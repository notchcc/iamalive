/**
 * 以 busboy 解析 multipart/form-data（Cloud Functions 已把 body 讀進 req.rawBody）。
 */
import Busboy from 'busboy';
import type { Request } from 'express';

export interface ParsedFile {
  field: string;
  filename: string;
  mimeType: string;
  data: Buffer;
}
export interface ParsedMultipart {
  fields: Record<string, string>;
  /** 主檔案（欄位 photo；沒有指名就取第一個檔案） */
  file: ParsedFile | null;
  /** 選配縮圖（欄位 thumb） */
  thumb: ParsedFile | null;
}

export function parseMultipart(req: Request, maxFileBytes: number): Promise<ParsedMultipart> {
  return new Promise((resolve, reject) => {
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!raw) {
      reject(new Error('NO_RAW_BODY'));
      return;
    }
    const bb = Busboy({ headers: req.headers, limits: { files: 2, fileSize: maxFileBytes, fields: 20, fieldSize: 4096 } });
    const out: ParsedMultipart = { fields: {}, file: null, thumb: null };
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
        const f = { field, filename: info.filename, mimeType: info.mimeType, data: Buffer.concat(chunks) };
        if (field === 'thumb') out.thumb = f;
        else if (!out.file || field === 'photo') out.file = f;
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
