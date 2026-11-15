'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // What the PSP actually settled, kept separate from the amount we asked for
    // so a disagreement stays visible instead of overwriting the request.
    await queryInterface.addColumn('funding_transactions', 'settled_amount', {
      type: Sequelize.DECIMAL(36, 18),
      allowNull: true,
    });
    await queryInterface.addColumn('funding_transactions', 'mismatch_reason', {
      type: Sequelize.TEXT,
      allowNull: true,
    });

    await queryInterface.sequelize.query(`
      ALTER TABLE funding_transactions
        ADD CONSTRAINT funding_transactions_settled_amount_non_negative
          CHECK (settled_amount IS NULL OR settled_amount >= 0)
    `);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('funding_transactions', 'mismatch_reason');
    await queryInterface.removeColumn('funding_transactions', 'settled_amount');
  },
};
