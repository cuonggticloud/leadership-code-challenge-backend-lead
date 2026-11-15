import { DataTypes, Model, Sequelize } from 'sequelize';

export const FundingKind = {
  Deposit: 'Deposit',
  Withdrawal: 'Withdrawal',
} as const;
export type FundingKind = (typeof FundingKind)[keyof typeof FundingKind];

export const FundingStatus = {
  Pending: 'Pending',
  Completed: 'Completed',
  Failed: 'Failed',
} as const;
export type FundingStatus = (typeof FundingStatus)[keyof typeof FundingStatus];

export class FundingTransaction extends Model {
  declare id: string;
  declare memberId: string;
  declare walletId: string;
  declare kind: FundingKind;
  declare status: FundingStatus;
  // DECIMAL comes back from the pg driver as a string. Keep it that way.
  declare amount: string;
  declare turnoverMultiplier: number;
  declare pspRef: string | null;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

export function initFundingTransaction(sequelize: Sequelize): void {
  FundingTransaction.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      memberId: { type: DataTypes.UUID, allowNull: false },
      walletId: { type: DataTypes.UUID, allowNull: false },
      kind: { type: DataTypes.TEXT, allowNull: false },
      status: { type: DataTypes.TEXT, allowNull: false, defaultValue: FundingStatus.Pending },
      amount: { type: DataTypes.DECIMAL(36, 18), allowNull: false },
      turnoverMultiplier: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      pspRef: { type: DataTypes.TEXT, allowNull: true },
    },
    { sequelize, tableName: 'funding_transactions', underscored: true },
  );
}
