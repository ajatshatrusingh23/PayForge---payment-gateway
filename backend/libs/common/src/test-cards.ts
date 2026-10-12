/**
 * Test-mode card numbers (all Luhn-valid). Like Stripe's test cards, each
 * number deterministically triggers one scenario in the bank simulator.
 */
export type TestCardOutcome =
  | 'success'
  | 'declined'
  | 'insufficient_funds'
  | 'otp_required'
  | 'acquirer_timeout'
  | 'international';

export interface TestCard {
  number: string;
  brand: string;
  outcome: TestCardOutcome;
  description: string;
}

export const TEST_CARDS: TestCard[] = [
  { number: '4111111111111111', brand: 'visa', outcome: 'success', description: 'Visa: payment succeeds' },
  { number: '5555555555554444', brand: 'mastercard', outcome: 'success', description: 'Mastercard: payment succeeds' },
  { number: '6522000000000006', brand: 'rupay', outcome: 'success', description: 'RuPay: payment succeeds' },
  { number: '4000000000003220', brand: 'visa', outcome: 'otp_required', description: 'Requires OTP (use 123456)' },
  { number: '4000000000000002', brand: 'visa', outcome: 'declined', description: 'Declined by issuer (do_not_honor)' },
  { number: '4000000000009995', brand: 'visa', outcome: 'insufficient_funds', description: 'Declined: insufficient funds' },
  {
    number: '4000000000000119',
    brand: 'visa',
    outcome: 'acquirer_timeout',
    description: 'Acquirer times out; payment resolves later via status check',
  },
  { number: '4000000760000002', brand: 'visa', outcome: 'international', description: 'International (US) card: succeeds, raises risk score' },
];

export const TEST_OTP = '123456';

export const TEST_VPAS = {
  success: 'success@pfbank',
  failure: 'fail@pfbank',
};

export function testCardOutcome(pan: string): TestCardOutcome | undefined {
  return TEST_CARDS.find((c) => c.number === pan)?.outcome;
}
