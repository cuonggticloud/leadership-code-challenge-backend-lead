'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Required turnover: completed deposits for one member.
    await queryInterface.addIndex('funding_transactions', ['member_id', 'kind', 'status'], {
      name: 'funding_transactions_member_kind_status_idx',
    });

    // Accrued turnover: wager entries for one wallet.
    await queryInterface.addIndex('wallet_txs', ['wallet_id', 'kind'], {
      name: 'wallet_txs_wallet_kind_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('wallet_txs', 'wallet_txs_wallet_kind_idx');
    await queryInterface.removeIndex(
      'funding_transactions',
      'funding_transactions_member_kind_status_idx',
    );
  },
};
