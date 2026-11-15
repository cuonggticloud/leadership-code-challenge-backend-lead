'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Audit of every callback delivery, recorded verbatim on arrival. When money
    // is disputed later, what the PSP sent and what we decided has to be
    // answerable from data rather than from log files.
    //
    // Deliberately not append-only: a row is inserted on arrival, before the
    // outcome is known, and updated once resolved. A row left with outcome NULL
    // means "received but never resolved", which is itself worth alerting on.
    await queryInterface.createTable('psp_callbacks', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      // As received. No FK: an unknown ref is exactly the case worth retaining.
      psp_ref: { type: Sequelize.TEXT, allowNull: false },
      status: { type: Sequelize.TEXT, allowNull: false },
      amount: { type: Sequelize.DECIMAL(36, 18), allowNull: true },
      payload: { type: Sequelize.JSONB, allowNull: false },
      outcome: { type: Sequelize.TEXT, allowNull: true },
      detail: { type: Sequelize.TEXT, allowNull: true },
      funding_transaction_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'funding_transactions', key: 'id' },
      },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });

    await queryInterface.sequelize.query(`
      ALTER TABLE psp_callbacks
        ADD CONSTRAINT psp_callbacks_outcome_check
          CHECK (outcome IS NULL OR outcome IN (
            'credited',
            'duplicate_ignored',
            'amount_mismatch',
            'unknown_ref',
            'marked_failed'
          ))
    `);

    await queryInterface.addIndex('psp_callbacks', ['psp_ref', 'created_at'], {
      name: 'psp_callbacks_ref_created_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('psp_callbacks');
  },
};
