'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('funding_transactions', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      member_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'members', key: 'id' },
      },
      wallet_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'wallets', key: 'id' },
      },
      kind: { type: Sequelize.TEXT, allowNull: false },
      status: { type: Sequelize.TEXT, allowNull: false, defaultValue: 'Pending' },
      amount: { type: Sequelize.DECIMAL(36, 18), allowNull: false },
      turnover_multiplier: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      // Deposits only. NULL for withdrawals - Postgres allows many NULLs under a
      // UNIQUE constraint, so this stays unique per deposit without a partial index.
      psp_ref: { type: Sequelize.TEXT, allowNull: true, unique: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });

    // The enums and the positivity rule are enforced in the database, not only in
    // zod: a bug in a service must not be able to persist a nonsense row.
    await queryInterface.sequelize.query(`
      ALTER TABLE funding_transactions
        ADD CONSTRAINT funding_transactions_kind_check
          CHECK (kind IN ('Deposit', 'Withdrawal')),
        ADD CONSTRAINT funding_transactions_status_check
          CHECK (status IN ('Pending', 'Completed', 'Failed')),
        ADD CONSTRAINT funding_transactions_amount_positive
          CHECK (amount > 0),
        ADD CONSTRAINT funding_transactions_multiplier_non_negative
          CHECK (turnover_multiplier >= 0),
        ADD CONSTRAINT funding_transactions_deposit_has_psp_ref
          CHECK (kind <> 'Deposit' OR psp_ref IS NOT NULL)
    `);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('funding_transactions');
  },
};
