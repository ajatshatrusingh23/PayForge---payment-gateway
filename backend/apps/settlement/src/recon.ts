/**
 * Three-way-style reconciliation, as a pure function (see recon.spec.ts).
 *
 * Platform side: settlement items created from our own captured/refunded events.
 * Acquirer side: lines from the acquirer's settlement report.
 * They are joined on merchant_ref (our attempt id / refund id), which we sent to the
 * acquirer with every request precisely so this join is possible.
 */
export interface PlatformItem {
  id: string;
  merchant_ref: string;
  amount: number;
  recon_status: 'unreconciled' | 'matched' | 'mismatch' | 'missing_in_acquirer';
  occurred_at: Date;
}

export interface AcquirerLine {
  acquirer_ref: string;
  merchant_ref: string;
  amount: number;
  ingested_at: Date;
  exception_raised: boolean;
}

export interface ReconWindow {
  /** Business day being reconciled: only items inside it can be declared missing at the acquirer. */
  start: Date;
  end: Date;
  /** Records younger than this are given time to appear on the other side (in-flight timing differences). */
  graceMs: number;
  now: Date;
}

export interface ReconResult {
  matched: Array<{ item: PlatformItem; line: AcquirerLine }>;
  mismatched: Array<{ item: PlatformItem; line: AcquirerLine }>;
  missingInAcquirer: PlatformItem[];
  missingInPlatform: AcquirerLine[];
}

export function reconcile(items: PlatformItem[], lines: AcquirerLine[], w: ReconWindow): ReconResult {
  const result: ReconResult = { matched: [], mismatched: [], missingInAcquirer: [], missingInPlatform: [] };
  const unmatchedLines = new Map(lines.map((l) => [l.merchant_ref, l]));

  for (const item of items) {
    const line = unmatchedLines.get(item.merchant_ref);
    if (line) {
      unmatchedLines.delete(item.merchant_ref);
      (line.amount === item.amount ? result.matched : result.mismatched).push({ item, line });
      continue;
    }
    const inWindow = item.occurred_at >= w.start && item.occurred_at < w.end;
    const pastGrace = w.now.getTime() - item.occurred_at.getTime() > w.graceMs;
    if (inWindow && pastGrace && item.recon_status === 'unreconciled') result.missingInAcquirer.push(item);
  }

  for (const line of unmatchedLines.values()) {
    const pastGrace = w.now.getTime() - line.ingested_at.getTime() > w.graceMs;
    if (pastGrace && !line.exception_raised) result.missingInPlatform.push(line);
  }
  return result;
}
