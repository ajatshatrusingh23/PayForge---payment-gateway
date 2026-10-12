import { ACQUIRERS, isAcquirerCode } from '@app/common';
import {
  AcquirerSettlementInternal,
  DomainEvent,
  EventTypes,
  PaymentCapturedInternal,
  PayoutPaidInternal,
  RefundSucceededInternal,
} from '@app/messaging';

/**
 * Chart of accounts and posting rules: how each business event moves money.
 * Pure functions, so every rule is unit/property tested to always balance.
 *
 * Normal balances: assets & expenses grow with debits; liabilities & revenue grow with credits.
 */
export type Direction = 'debit' | 'credit';
export type AccountType = 'asset' | 'liability' | 'revenue' | 'expense';

export interface AccountRef {
  id: string;
  type: AccountType;
  name: string;
  merchantId?: string;
}

export interface Line {
  account: AccountRef;
  direction: Direction;
  amount: number;
}

export interface JournalSpec {
  description: string;
  merchantId: string | null;
  referenceId: string;
  lines: Line[];
}

export const Accounts = {
  merchantPayable: (merchantId: string): AccountRef => ({
    id: `merchant:${merchantId}:payable`,
    type: 'liability',
    name: 'Merchant payable',
    merchantId,
  }),
  acquirerReceivable: (acquirer: string): AccountRef => ({
    id: `acquirer:${acquirer}:receivable`,
    type: 'asset',
    name: `${isAcquirerCode(acquirer) ? ACQUIRERS[acquirer].name : acquirer} receivable`,
  }),
  feeRevenue: { id: 'platform:fee_revenue', type: 'revenue', name: 'Platform fee revenue' } as AccountRef,
  gstPayable: { id: 'platform:gst_payable', type: 'liability', name: 'GST payable' } as AccountRef,
  acquirerFees: { id: 'platform:acquirer_fees', type: 'expense', name: 'Acquirer processing fees' } as AccountRef,
  bank: { id: 'platform:bank', type: 'asset', name: 'Platform settlement bank account' } as AccountRef,
};

const debit = (account: AccountRef, amount: number): Line => ({ account, direction: 'debit', amount });
const credit = (account: AccountRef, amount: number): Line => ({ account, direction: 'credit', amount });
const nonZero = (lines: Line[]) => lines.filter((l) => l.amount > 0);

export function postingsFor(event: DomainEvent): JournalSpec | null {
  const objectId = String((event.data?.object as { id?: string })?.id ?? '');

  switch (event.type) {
    case EventTypes.paymentCaptured: {
      // Customer paid A. The acquirer owes us A (less its fee). We owe the merchant A minus our
      // fee and GST. We earn the fee, owe GST to the government, and pay the acquirer its cost.
      const i = event.internal as unknown as PaymentCapturedInternal;
      const merchant = event.merchant_id!;
      return {
        description: `Payment ${objectId} captured via ${i.acquirer}`,
        merchantId: merchant,
        referenceId: objectId,
        lines: nonZero([
          debit(Accounts.acquirerReceivable(i.acquirer), i.amount),
          credit(Accounts.merchantPayable(merchant), i.net),
          credit(Accounts.feeRevenue, i.fee),
          credit(Accounts.gstPayable, i.gst),
          debit(Accounts.acquirerFees, i.acquirer_fee),
          credit(Accounts.acquirerReceivable(i.acquirer), i.acquirer_fee),
        ]),
      };
    }

    case EventTypes.refundSucceeded: {
      // Merchant bears the refund (platform fees are not returned, same as most gateways).
      const i = event.internal as unknown as RefundSucceededInternal;
      return {
        description: `Refund ${i.refund_id} for ${i.payment_intent_id}`,
        merchantId: event.merchant_id,
        referenceId: i.refund_id,
        lines: nonZero([debit(Accounts.merchantPayable(event.merchant_id!), i.amount), credit(Accounts.acquirerReceivable(i.acquirer), i.amount)]),
      };
    }

    case EventTypes.acquirerSettlementReceived: {
      // The acquirer wired its net settlement to our bank account.
      const i = event.internal as unknown as AcquirerSettlementInternal;
      if (i.net_amount === 0) return null;
      const amount = Math.abs(i.net_amount);
      const lines =
        i.net_amount > 0
          ? [debit(Accounts.bank, amount), credit(Accounts.acquirerReceivable(i.acquirer), amount)]
          : [debit(Accounts.acquirerReceivable(i.acquirer), amount), credit(Accounts.bank, amount)];
      return {
        description: `Settlement from ${i.acquirer} for ${i.business_date} (run ${i.run_id})`,
        merchantId: null,
        referenceId: i.run_id,
        lines,
      };
    }

    case EventTypes.payoutPaid: {
      const i = event.internal as unknown as PayoutPaidInternal;
      return {
        description: `Payout ${i.payout_id} to merchant bank account`,
        merchantId: event.merchant_id,
        referenceId: i.payout_id,
        lines: nonZero([debit(Accounts.merchantPayable(event.merchant_id!), i.amount), credit(Accounts.bank, i.amount)]),
      };
    }

    default:
      return null;
  }
}

export function isBalanced(lines: Line[]): boolean {
  let net = 0;
  for (const l of lines) net += l.direction === 'debit' ? l.amount : -l.amount;
  return net === 0 && lines.length >= 2;
}

/** Signed balance in the account's normal direction. */
export function normalBalance(type: AccountType, debits: number, credits: number): number {
  return type === 'asset' || type === 'expense' ? debits - credits : credits - debits;
}
