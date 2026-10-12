import { Migration } from '@app/database';

export const migrations: Migration[] = [
  {
    id: '001_ledger',
    sql: `
      CREATE TABLE accounts (
        id          text        PRIMARY KEY,
        type        text        NOT NULL CHECK (type IN ('asset', 'liability', 'revenue', 'expense')),
        name        text        NOT NULL,
        merchant_id text,
        currency    text        NOT NULL DEFAULT 'INR',
        created_at  timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE journal_entries (
        id           text        PRIMARY KEY,
        event_id     text        NOT NULL UNIQUE,   -- one journal per source event: idempotent posting
        event_type   text        NOT NULL,
        merchant_id  text,
        reference_id text        NOT NULL,
        description  text        NOT NULL,
        created_at   timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX journal_entries_merchant_idx ON journal_entries (merchant_id, created_at DESC);
      CREATE INDEX journal_entries_reference_idx ON journal_entries (reference_id);

      CREATE TABLE ledger_lines (
        id         bigserial   PRIMARY KEY,
        journal_id text        NOT NULL REFERENCES journal_entries(id),
        account_id text        NOT NULL REFERENCES accounts(id),
        direction  text        NOT NULL CHECK (direction IN ('debit', 'credit')),
        amount     bigint      NOT NULL CHECK (amount > 0),
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX ledger_lines_account_idx ON ledger_lines (account_id);
      CREATE INDEX ledger_lines_journal_idx ON ledger_lines (journal_id);

      -- Invariant 1: the ledger is append-only. Mistakes are fixed with reversing entries, never edits.
      CREATE FUNCTION ledger_forbid_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'ledger is append-only: % on % is not allowed', TG_OP, TG_TABLE_NAME;
      END $$ LANGUAGE plpgsql;

      CREATE TRIGGER ledger_lines_append_only BEFORE UPDATE OR DELETE ON ledger_lines
        FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation();
      CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON journal_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation();

      -- Invariant 2: every journal balances (sum of debits = sum of credits).
      -- A DEFERRED constraint trigger runs at COMMIT, after all lines of the journal are inserted,
      -- so an unbalanced journal can never be committed, whatever bug exists in application code.
      CREATE FUNCTION ledger_check_balanced() RETURNS trigger AS $$
      DECLARE
        total_debits  bigint;
        total_credits bigint;
      BEGIN
        SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0),
               COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)
          INTO total_debits, total_credits
          FROM ledger_lines WHERE journal_id = NEW.journal_id;
        IF total_debits <> total_credits THEN
          RAISE EXCEPTION 'journal % is unbalanced: debits=% credits=%', NEW.journal_id, total_debits, total_credits;
        END IF;
        RETURN NULL;
      END $$ LANGUAGE plpgsql;

      CREATE CONSTRAINT TRIGGER ledger_lines_balanced AFTER INSERT ON ledger_lines
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();
    `,
  },
];
