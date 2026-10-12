import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { counter, IdPrefix, newId } from '@app/common';
import { Db } from '@app/database';
import { DomainEvent, KafkaService, Topics } from '@app/messaging';
import { AccountType, Accounts, isBalanced, JournalSpec, normalBalance, postingsFor } from './postings';

const journalsPosted = counter('payforge_ledger_journals_total', 'Journals posted to the ledger', ['event_type'] as const);

@Injectable()
export class LedgerService implements OnModuleInit {
  private readonly logger = new Logger('Ledger');

  constructor(
    private readonly db: Db,
    private readonly kafka: KafkaService,
  ) {}

  onModuleInit(): void {
    this.kafka.subscribe('ledger', [Topics.payments, Topics.settlements], (event) => this.handle(event));
  }

  async handle(event: DomainEvent): Promise<void> {
    const spec = postingsFor(event);
    if (!spec) return;
    if (!isBalanced(spec.lines)) throw new Error(`Refusing to post unbalanced journal for ${event.type} ${event.id}`);
    const posted = await this.post(event, spec);
    if (posted) {
      journalsPosted.inc({ event_type: event.type });
      this.logger.log(`Posted ${event.type} for ${spec.referenceId} (${spec.lines.length} lines)`);
    }
  }

  /** Idempotent: the UNIQUE(event_id) constraint means a redelivered event is posted exactly once. */
  private async post(event: DomainEvent, spec: JournalSpec): Promise<boolean> {
    return this.db.tx(async (c) => {
      const journalId = newId(IdPrefix.journal);
      const inserted = await c.query(
        `INSERT INTO journal_entries (id, event_id, event_type, merchant_id, reference_id, description)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (event_id) DO NOTHING`,
        [journalId, event.id, event.type, spec.merchantId, spec.referenceId, spec.description],
      );
      if (inserted.rowCount === 0) return false;

      const accounts = new Map(spec.lines.map((l) => [l.account.id, l.account]));
      for (const account of accounts.values()) {
        await c.query(
          `INSERT INTO accounts (id, type, name, merchant_id) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
          [account.id, account.type, account.name, account.merchantId ?? null],
        );
      }
      const values: unknown[] = [];
      const tuples = spec.lines.map((line, i) => {
        values.push(journalId, line.account.id, line.direction, line.amount);
        return `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`;
      });
      await c.query(`INSERT INTO ledger_lines (journal_id, account_id, direction, amount) VALUES ${tuples.join(', ')}`, values);
      return true;
    });
  }

  async balance(merchantId: string) {
    const account = Accounts.merchantPayable(merchantId).id;
    const row = await this.db.one<{ credits: number; debits: number; paid_out: number; refunded: number }>(
      `SELECT COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'credit'), 0) AS credits,
              COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'debit'), 0) AS debits,
              COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'debit' AND j.event_type = 'payout.paid'), 0) AS paid_out,
              COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'debit' AND j.event_type = 'refund.succeeded'), 0) AS refunded
       FROM ledger_lines l JOIN journal_entries j ON j.id = l.journal_id
       WHERE l.account_id = $1`,
      [account],
    );
    const r = row!;
    return {
      object: 'balance',
      currency: 'INR',
      account,
      available: r.credits - r.debits,
      lifetime: { net_earnings: r.credits, refunded: r.refunded, paid_out: r.paid_out },
    };
  }

  async journals(merchantId: string, referenceId: string | undefined, limit: number) {
    const rows = await this.db.many(
      `SELECT j.id, j.event_type, j.reference_id, j.description, j.created_at,
              json_agg(json_build_object('account', l.account_id, 'direction', l.direction, 'amount', l.amount) ORDER BY l.id) AS lines
       FROM journal_entries j JOIN ledger_lines l ON l.journal_id = j.id
       WHERE j.merchant_id = $1 AND ($2::text IS NULL OR j.reference_id = $2)
       GROUP BY j.id
       ORDER BY j.created_at DESC
       LIMIT $3`,
      [merchantId, referenceId ?? null, limit],
    );
    return { object: 'list', data: rows.map((r) => ({ object: 'journal_entry', ...r })) };
  }

  /**
   * Proves the books are consistent: total debits = total credits, no unbalanced
   * journal exists, and the trial balance satisfies Assets + Expenses = Liabilities + Revenue.
   */
  async integrity(merchantId: string) {
    const totals = await this.db.one<{ debits: number; credits: number; journals: number; lines: number }>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0) AS debits,
              COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0) AS credits,
              count(DISTINCT journal_id) AS journals, count(*) AS lines
       FROM ledger_lines`,
    );
    const unbalanced = await this.db.many(
      `SELECT journal_id, SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) AS difference
       FROM ledger_lines GROUP BY journal_id
       HAVING SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) <> 0 LIMIT 20`,
    );
    const accounts = await this.db.many<{ id: string; type: AccountType; name: string; merchant_id: string | null; debits: number; credits: number }>(
      `SELECT a.id, a.type, a.name, a.merchant_id,
              COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'debit'), 0) AS debits,
              COALESCE(SUM(l.amount) FILTER (WHERE l.direction = 'credit'), 0) AS credits
       FROM accounts a LEFT JOIN ledger_lines l ON l.account_id = a.id
       GROUP BY a.id ORDER BY a.type, a.id`,
    );

    // Other merchants' balances are private: aggregate them into one row.
    const trialBalance: Array<{ account: string; name: string; type: AccountType; debits: number; credits: number; balance: number }> = [];
    const others = { debits: 0, credits: 0 };
    let otherCount = 0;
    for (const a of accounts) {
      if (a.merchant_id && a.merchant_id !== merchantId) {
        others.debits += a.debits;
        others.credits += a.credits;
        otherCount++;
        continue;
      }
      trialBalance.push({ account: a.id, name: a.name, type: a.type, debits: a.debits, credits: a.credits, balance: normalBalance(a.type, a.debits, a.credits) });
    }
    if (otherCount) {
      trialBalance.push({
        account: 'merchant:*:payable',
        name: `Other merchants' payables (${otherCount})`,
        type: 'liability',
        debits: others.debits,
        credits: others.credits,
        balance: others.credits - others.debits,
      });
    }

    const sumBy = (types: AccountType[]) => trialBalance.filter((t) => types.includes(t.type)).reduce((s, t) => s + t.balance, 0);
    const left = sumBy(['asset', 'expense']);
    const right = sumBy(['liability', 'revenue']);
    const t = totals!;
    return {
      object: 'ledger_integrity',
      balanced: t.debits === t.credits && unbalanced.length === 0 && left === right,
      total_debits: t.debits,
      total_credits: t.credits,
      journal_count: t.journals,
      line_count: t.lines,
      unbalanced_journals: unbalanced,
      accounting_equation: { assets_plus_expenses: left, liabilities_plus_revenue: right },
      trial_balance: trialBalance,
      checked_at: new Date().toISOString(),
    };
  }
}
