'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // The append-only ledger. One row per balance change, so a wallet balance is
    // always reconstructible as SUM(amount).
    await queryInterface.createTable('wallet_txs', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      wallet_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'wallets', key: 'id' },
      },
      kind: { type: Sequelize.TEXT, allowNull: false },
      // Signed: credits positive, debits negative. Keeping the sign in the amount
      // rather than implying it from kind makes reconstruction a plain SUM and
      // removes a class of "forgot to negate" bugs.
      amount: { type: Sequelize.DECIMAL(36, 18), allowNull: false },
      // Redundant by design: lets drift between the ledger and wallets.balance be
      // detected rather than assumed impossible.
      balance_after: { type: Sequelize.DECIMAL(36, 18), allowNull: false },
      funding_transaction_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'funding_transactions', key: 'id' },
      },
      // The hard idempotency guarantee: a second attempt to apply the same money
      // movement is refused by Postgres, whatever the application believes.
      idempotency_key: { type: Sequelize.TEXT, allowNull: false, unique: true },
      // No updated_at: rows are never modified. Enforced by the trigger below.
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });

    await queryInterface.sequelize.query(`
      ALTER TABLE wallet_txs
        ADD CONSTRAINT wallet_txs_kind_check
          CHECK (kind IN ('DepositCredit', 'Wager', 'WithdrawalDebit')),
        ADD CONSTRAINT wallet_txs_amount_non_zero
          CHECK (amount <> 0),
        ADD CONSTRAINT wallet_txs_credit_sign
          CHECK (kind <> 'DepositCredit' OR amount > 0),
        ADD CONSTRAINT wallet_txs_debit_sign
          CHECK (kind = 'DepositCredit' OR amount < 0),
        ADD CONSTRAINT wallet_txs_balance_after_non_negative
          CHECK (balance_after >= 0)
    `);

    // Append-only should be a property the database guarantees, not a rule every
    // future service has to remember. An UPDATE or DELETE here is always a bug.
    await queryInterface.sequelize.query(`
      CREATE FUNCTION wallet_txs_reject_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_txs is append-only (attempted %)', TG_OP;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER wallet_txs_append_only
        BEFORE UPDATE OR DELETE ON wallet_txs
        FOR EACH ROW EXECUTE FUNCTION wallet_txs_reject_mutation();
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS wallet_txs_append_only ON wallet_txs;
      DROP FUNCTION IF EXISTS wallet_txs_reject_mutation();
    `);
    await queryInterface.dropTable('wallet_txs');
  },
};
