import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const runtime = 'nodejs'; // Restrict to Node.js runtime for file system access

const LOGS_DIR = path.join(process.cwd(), 'logs');

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { timestamp, method, path: reqPath, userId, ip, userAgent, status } = body;

    // Ensure the logs directory exists
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }

    // Format daily file name: audit-YYYY-MM-DD.txt
    const dateStr = new Date().toISOString().split('T')[0];
    const logFilePath = path.join(LOGS_DIR, `audit-${dateStr}.txt`);

    // Format log entry line
    const logLine = `[${timestamp}] ${method} ${reqPath} - Status: ${status || '—'} - User: ${userId || 'Anonymous'} - IP: ${ip} - UA: ${userAgent}\n`;

    // Append log line synchronously
    fs.appendFileSync(logFilePath, logLine);

    // Clean up files older than 30 days
    await pruneOldLogs();

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('[Logs API Error]', error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

/**
 * Scans the /logs folder and removes files older than 30 days.
 */
async function pruneOldLogs() {
  try {
    if (!fs.existsSync(LOGS_DIR)) return;

    const files = fs.readdirSync(LOGS_DIR);
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    files.forEach((file) => {
      const match = file.match(/^audit-(\d{4}-\d{2}-\d{2})\.txt$/);
      if (match) {
        const fileDateStr = match[1];
        const fileDate = new Date(fileDateStr);

        if (fileDate < thirtyDaysAgo) {
          const filePath = path.join(LOGS_DIR, file);
          fs.unlinkSync(filePath);
          console.log(`[Log Pruner] Deleted expired file: ${file}`);
        }
      }
    });
  } catch (err: any) {
    console.error('[Log Pruner Error]', err.message);
  }
}
