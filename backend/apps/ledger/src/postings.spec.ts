import fc from 'fast-check';
import { applyBps, computeFees } from '@app/common';
import { buildEvent, EventTypes } from '@app/messaging';
import { isBalanced, postingsFor } from './postings';

const captured = (amount: number, feeBps = 200, acquirerBps = 180) => {
  const fees = computeFees(amount, feeBps);
  return buildEvent(
    EventTypes.paymentCaptured,
    'acct_1',
    { id: 'pi_1' },
    {
      attempt_id: 'pa_1',
      acquirer: 'alpha',
      acquirer_ref: 'ALPHA_1',
      method: 'card',
      amount,
      fee: fees.fee,
      gst: fees.gst,
      net: fees.net,
      acquirer_fee: applyBps(amount, acquirerBps),
      captured_at: new Date().toISOString(),
    },
  );
};

describe('ledger posting rules', () => {
  it('posts the ₹499 capture exactly as in the case study', () => {
    const journal = postingsFor(captured(49_900))!;
    const byAccount = Object.fromEntries(journal.lines.map((l) => [`${l.direction}:${l.account.id}`, l.amount]));
    expect(byAccount['debit:acquirer:alpha:receivable']).toBe(49_900);
    expect(byAccount['credit:merchant:acct_1:payable']).toBe(48_722);
    expect(byAccount['credit:platform:fee_revenue']).toBe(998);
    expect(byAccount['credit:platform:gst_payable']).toBe(180);
    expect(isBalanced(journal.lines)).toBe(true);
  });

  it('property: every capture journal balances, for any amount and pricing', () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 50_000_000 }), fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 0, max: 500 }), (amount, feeBps, acqBps) =>
        isBalanced(postingsFor(captured(amount, feeBps, acqBps))!.lines),
      ),
    );
  });

  it('property: refunds, settlements and payouts always balance', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50_000_000 }), fc.integer({ min: -50_000_000, max: 50_000_000 }), (amount, net) => {
        const refund = postingsFor(
          buildEvent(EventTypes.refundSucceeded, 'acct_1', { id: 're_1' }, {
            refund_id: 're_1',
            payment_intent_id: 'pi_1',
            acquirer: 'beta',
            acquirer_ref: 'B_1',
            amount,
            succeeded_at: '',
          }),
        )!;
        const payout = postingsFor(buildEvent(EventTypes.payoutPaid, 'acct_1', { id: 'po_1' }, { payout_id: 'po_1', amount }))!;
        const settlement = postingsFor(
          buildEvent(EventTypes.acquirerSettlementReceived, null, { id: 'rr_1' }, {
            run_id: 'rr_1',
            acquirer: 'beta',
            business_date: '2026-10-11',
            gross_amount: 0,
            refund_amount: 0,
            acquirer_fees: 0,
            net_amount: net,
          }),
        );
        return isBalanced(refund.lines) && isBalanced(payout.lines) && (net === 0 ? settlement === null : isBalanced(settlement!.lines));
      }),
    );
  });

  it('ignores events that do not move money', () => {
    expect(postingsFor(buildEvent(EventTypes.paymentCreated, 'acct_1', { id: 'pi_1' }))).toBeNull();
  });

  it('rejects unbalanced or single-line journals', () => {
    const account = { id: 'a', type: 'asset' as const, name: 'a' };
    expect(isBalanced([{ account, direction: 'debit', amount: 10 }])).toBe(false);
    expect(isBalanced([{ account, direction: 'debit', amount: 10 }, { account, direction: 'credit', amount: 9 }])).toBe(false);
  });
});
