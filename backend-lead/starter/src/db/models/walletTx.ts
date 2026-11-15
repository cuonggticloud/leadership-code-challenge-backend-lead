import { DataTypes, Model, Sequelize } from 'sequelize';

export const WalletTxKind = {
  DepositCredit: 'DepositCredit',
  Wager: 'Wager',
  WithdrawalDebit: 'WithdrawalDebit',
} as const;
export type WalletTxKind = (typeof WalletTxKind)[keyof typeof WalletTxKind];

export class WalletTx extends Model {
  declare id: string;
  declare walletId: string;
  declare kind: WalletTxKind;
  // Signed: credits positive, debits negative.
  declare amount: string;
  declare balanceAfter: string;
  declare fundingTransactionId: string | null;
  declare idempotencyKey: string;
  declare readonly createdAt: Date;
}

export function initWalletTx(sequelize: Sequelize): void {
  WalletTx.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      walletId: { type: DataTypes.UUID, allowNull: false },
      kind: { type: DataTypes.TEXT, allowNull: false },
      amount: { type: DataTypes.DECIMAL(36, 18), allowNull: false },
      balanceAfter: { type: DataTypes.DECIMAL(36, 18), allowNull: false },
      fundingTransactionId: { type: DataTypes.UUID, allowNull: true },
      idempotencyKey: { type: DataTypes.TEXT, allowNull: false },
    },
    {
      sequelize,
      tableName: 'wallet_txs',
      underscored: true,
      // Append-only: no updated_at column, and a DB trigger rejects UPDATE and
      // DELETE. Telling Sequelize keeps it from generating either.
      updatedAt: false,
    },
  );
}
